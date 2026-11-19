// Speaker labels for the system channel ("Them"), kept in speakers.json next to
// transcript.jsonl:
//   { version: 1, turns: [{ startMs, endMs, speaker }], assigned: { <chunk key>: speaker },
//     names: { <speaker>: "Alan" }, mergedInto: { <speaker>: <speaker> } }
// The transcript itself is never rewritten: labels are applied when it is read,
// so renaming and merging only change this small file (and can be undone), and
// recordings without the file show "Them" exactly as before.
// Speaker numbers stay stable: "Speaker 3" keeps its number when 2 is merged away.
const VERSION = 1;
const MAX_NAME = 40;

const chunkKey = (c) => c.id ?? `${c.source}@${c.startMs}`;
const defaultLabel = (n) => `Speaker ${Number(n) + 1}`;

// For every system chunk, the speaker whose turns overlap it most. On a tie the
// speaker who spoke first within the chunk wins. Chunks with no overlap stay
// unassigned ("Them"); microphone chunks are never touched.
function assignSpeakers(chunks, turns) {
  const assigned = {};
  for (const c of chunks) {
    if (c.source !== 'system') continue;
    const end = c.endMs ?? c.startMs;
    const overlap = new Map(); // speaker -> { ms, first }
    for (const t of turns) {
      const ms = Math.min(end, t.endMs) - Math.max(c.startMs, t.startMs);
      if (ms <= 0) continue;
      const o = overlap.get(t.speaker) ?? { ms: 0, first: Infinity };
      o.ms += ms;
      o.first = Math.min(o.first, Math.max(c.startMs, t.startMs));
      overlap.set(t.speaker, o);
    }
    let best = null;
    for (const [speaker, o] of overlap) {
      if (!best || o.ms > best.ms || (o.ms === best.ms && o.first < best.first)) best = { speaker, ...o };
    }
    if (best) assigned[chunkKey(c)] = best.speaker;
  }
  return assigned;
}

function createSpeakers(chunks, turns) {
  return { version: VERSION, turns, assigned: assignSpeakers(chunks, turns), names: {}, mergedInto: {} };
}

// Follows merges to the speaker a number now belongs to (cycle-safe).
function resolve(data, n) {
  const seen = new Set();
  let cur = Number(n);
  while (data.mergedInto?.[cur] !== undefined && !seen.has(cur)) {
    seen.add(cur);
    cur = Number(data.mergedInto[cur]);
  }
  return cur;
}

function speakerLabel(data, n) {
  const id = resolve(data, n);
  return data.names?.[id] || defaultLabel(id);
}

// Chunks with .speaker (label) and .speakerId on assigned system chunks.
function labelChunks(chunks, data) {
  if (!data) return chunks;
  return chunks.map((c) => {
    const n = data.assigned?.[chunkKey(c)];
    if (c.source !== 'system' || n === undefined) return c;
    return { ...c, speakerId: resolve(data, n), speaker: speakerLabel(data, n) };
  });
}

// All speakers ever found: [{ id, label, named, lines, ms, mergedInto, merged: [ids] }].
// Speech time and lines count the transcript lines each speaker now has.
function speakerList(chunks, data) {
  if (!data) return [];
  const ids = new Set(Object.values(data.assigned).map(Number));
  const stats = new Map([...ids].map((id) => [id, { lines: 0, ms: 0 }]));
  for (const c of labelChunks(chunks, data)) {
    if (c.speakerId === undefined) continue;
    const s = stats.get(c.speakerId) ?? { lines: 0, ms: 0 };
    s.lines++;
    s.ms += Math.max(0, (c.endMs ?? c.startMs) - c.startMs);
    stats.set(c.speakerId, s);
  }
  return [...ids].sort((a, b) => a - b).map((id) => {
    const into = data.mergedInto?.[id];
    return {
      id,
      label: speakerLabel(data, id),
      named: Boolean(data.names?.[id]),
      mergedInto: into === undefined ? null : resolve(data, id),
      merged: [...ids].filter((o) => o !== id && data.mergedInto?.[o] !== undefined && resolve(data, o) === id),
      ...(into === undefined ? stats.get(id) : { lines: 0, ms: 0 }),
    };
  });
}

// A name safe for the transcript, the Markdown document and the summary prompt.
function cleanName(name) {
  return String(name ?? '').replace(/[\u0000-\u001f\u007f*_`[\]<>|#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
}

const known = (data, n) => Object.values(data.assigned).some((v) => Number(v) === Number(n));
const active = (data) => [...new Set(Object.values(data.assigned).map(Number))].filter((id) => data.mergedInto?.[id] === undefined);

// Blank resets to "Speaker N". Returns new data; throws a user-facing message.
function renameSpeaker(data, n, name) {
  const id = Number(n);
  if (!known(data, id)) throw new Error('Unknown speaker');
  if (data.mergedInto?.[id] !== undefined) throw new Error('This speaker was merged; rename the one it was merged into');
  const clean = cleanName(name);
  const names = { ...data.names };
  if (!clean || clean === defaultLabel(id)) {
    delete names[id];
    return { ...data, names };
  }
  const lower = clean.toLowerCase();
  if (['me', 'them'].includes(lower)) throw new Error(`"${clean}" is already used for a channel; choose another name`);
  const taken = active(data).find((o) => o !== id && speakerLabel(data, o).toLowerCase() === lower);
  if (taken !== undefined) throw new Error(`${speakerLabel(data, taken)} already has this name; merge them instead`);
  names[id] = clean;
  return { ...data, names };
}

// Moves every line of `from` to `into`. Undone with unmergeSpeaker.
function mergeSpeaker(data, from, into) {
  const a = Number(from);
  const b = resolve(data, into);
  if (!known(data, a) || !known(data, b)) throw new Error('Unknown speaker');
  if (data.mergedInto?.[a] !== undefined) throw new Error('This speaker is already merged');
  if (a === b) throw new Error('A speaker cannot be merged into itself');
  return { ...data, mergedInto: { ...data.mergedInto, [a]: b } };
}

function unmergeSpeaker(data, n) {
  const mergedInto = { ...data.mergedInto };
  delete mergedInto[Number(n)];
  return { ...data, mergedInto };
}

module.exports = {
  VERSION,
  MAX_NAME,
  chunkKey,
  defaultLabel,
  assignSpeakers,
  createSpeakers,
  resolve,
  speakerLabel,
  labelChunks,
  speakerList,
  cleanName,
  renameSpeaker,
  mergeSpeaker,
  unmergeSpeaker,
};
