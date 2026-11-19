// Second pass after clustering, against over-splitting: one embedding per found
// speaker (from all of that speaker's audio, far steadier than the short pieces
// the clustering saw), then
//   1. speakers whose embeddings are very similar are joined, most similar first;
//   2. "speakers" with only a few seconds in total are moved to the nearest
//      remaining speaker.
// Pure functions except clusterAudio(); the worker computes the embeddings.
const SAMPLE_RATE = 16000;

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// speaker -> total ms of speech
function speakerDurations(turns) {
  const out = new Map();
  for (const t of turns) out.set(t.speaker, (out.get(t.speaker) ?? 0) + (t.endMs - t.startMs));
  return out;
}

// The speaker's audio, longest pieces first, up to maxMs. Times are relative to
// the samples (subtract the recording offset first).
function clusterAudio(turns, speaker, samples, maxMs = 60_000) {
  const pieces = turns.filter((t) => t.speaker === speaker).sort((a, b) => (b.endMs - b.startMs) - (a.endMs - a.startMs));
  const parts = [];
  let total = 0;
  for (const t of pieces) {
    if (total >= maxMs) break;
    const start = Math.max(0, Math.floor((t.startMs * SAMPLE_RATE) / 1000));
    const end = Math.min(samples.length, Math.ceil((Math.min(t.endMs, t.startMs + maxMs - total) * SAMPLE_RATE) / 1000));
    if (end <= start) continue;
    parts.push(samples.subarray(start, end));
    total += ((end - start) / SAMPLE_RATE) * 1000;
  }
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// durations: Map speaker -> ms; embeddings: Map speaker -> Float32Array (a
// speaker without one is left alone). Returns Map from -> to (only changed ones).
//   similarity: join speakers whose cosine similarity is at least this (0 = off)
//   minMs:      move speakers with less speech than this to the nearest one (0 = off)
//   count:      the user's number of speakers: join the most similar until this many are left (0 = off)
function planMerges({ durations, embeddings, similarity = 0, minMs = 0, count = 0 }) {
  const groups = new Map(); // representative -> { ms, emb: number[] (duration-weighted sum), members }
  for (const [speaker, ms] of durations) {
    const emb = embeddings.get(speaker);
    if (!emb) continue;
    const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0)) || 1;
    groups.set(speaker, { ms, emb: Array.from(emb, (v) => (v / norm) * ms), members: [speaker] });
  }
  const join = (keep, drop) => {
    const a = groups.get(keep);
    const b = groups.get(drop);
    a.ms += b.ms;
    a.emb = a.emb.map((v, i) => v + b.emb[i]);
    a.members.push(...b.members);
    groups.delete(drop);
  };
  // The larger speaker keeps its number.
  const ordered = (x, y) => (groups.get(x).ms >= groups.get(y).ms ? [x, y] : [y, x]);

  // 1. Tiny speakers first: laughter, music or crosstalk often forms clusters
  // unlike every real voice, and joining by similarity before removing them
  // would merge two real speakers instead. Never below the user's count.
  if (minMs > 0) {
    const big = [...groups.keys()].filter((k) => groups.get(k).ms >= minMs);
    if (big.length > 0) {
      // Smallest first, each into the nearest big speaker (big ones do not move).
      const small = [...groups.keys()].filter((k) => groups.get(k).ms < minMs).sort((x, y) => groups.get(x).ms - groups.get(y).ms);
      for (const s of small) {
        if (count > 0 && groups.size <= count) break;
        let target = big[0];
        let bestSim = -Infinity;
        for (const b of big) {
          const sim = cosine(groups.get(s).emb, groups.get(b).emb);
          if (sim > bestSim) {
            bestSim = sim;
            target = b;
          }
        }
        join(target, s);
      }
    }
  }

  // 2. Join the most similar speakers: while at least `similarity` alike, and
  // in any case while there are more than the user's count.
  if (similarity > 0 || count > 0) {
    for (;;) {
      const needMore = count > 0 && groups.size > count;
      let best = null;
      const keys = [...groups.keys()];
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          const sim = cosine(groups.get(keys[i]).emb, groups.get(keys[j]).emb);
          const allowed = needMore || (similarity > 0 && sim >= similarity && !(count > 0 && groups.size <= count));
          if (allowed && (!best || sim > best.sim)) best = { sim, pair: [keys[i], keys[j]] };
        }
      }
      if (!best) break;
      join(...ordered(...best.pair));
    }
  }

  const map = new Map();
  for (const [rep, g] of groups) for (const m of g.members) if (m !== rep) map.set(m, rep);
  return map;
}

// Relabels turns, renumbers speakers 0, 1, 2, … by first appearance and joins
// back-to-back turns of the same speaker (gap below joinGapMs).
function applyMerges(turns, map, joinGapMs = 500) {
  const ids = new Map();
  const out = [];
  for (const t of [...turns].sort((a, b) => a.startMs - b.startMs)) {
    const speaker = map.get(t.speaker) ?? t.speaker;
    if (!ids.has(speaker)) ids.set(speaker, ids.size);
    const id = ids.get(speaker);
    const last = out.at(-1);
    if (last && last.speaker === id && t.startMs - last.endMs < joinGapMs) last.endMs = Math.max(last.endMs, t.endMs);
    else out.push({ startMs: t.startMs, endMs: t.endMs, speaker: id });
  }
  return out;
}

// Runs the whole second pass. embed(Float32Array) -> Float32Array embedding.
// minShare: a speaker with less than this share of all speech also counts as
// tiny (the cut-off is the larger of minMs and minShare × total speech).
function mergeSpeakers(turns, samples, embed, { similarity = 0, minMs = 0, minShare = 0, count = 0 } = {}) {
  if (!(similarity > 0) && !(minMs > 0) && !(minShare > 0) && !(count > 0)) return turns;
  const durations = speakerDurations(turns);
  if (durations.size < 2) return turns;
  const totalMs = [...durations.values()].reduce((a, b) => a + b, 0);
  const tinyMs = Math.max(minMs, minShare * totalMs);
  const embeddings = new Map();
  for (const speaker of durations.keys()) {
    const audio = clusterAudio(turns, speaker, samples);
    if (audio.length >= SAMPLE_RATE / 2) embeddings.set(speaker, embed(audio));
  }
  return applyMerges(turns, planMerges({ durations, embeddings, similarity, minMs: tinyMs, count }));
}

module.exports = { cosine, speakerDurations, clusterAudio, planMerges, applyMerges, mergeSpeakers };
