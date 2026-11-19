// Compares speaker-separation settings on test recordings (developer tool,
// runs fully offline once the models are on disk).
//
//   node scripts/diarize-eval.mjs --models <dir> [--threads 4,8] [--thresholds 0.7,0.8,0.9]
//        [--speakers N] call-en.wav[:call-en.rttm] call-de.wav[:call-de.rttm] ...
//
// <dir> holds segmentation.onnx plus one or more embedding *.onnx files; every
// embedding is tried. Audio: 16 kHz mono 16-bit WAV, or rec.io's raw .pcm.
// Convert anything else first: ffmpeg -i in.m4a -ac 1 -ar 16000 -sample_fmt s16 out.wav
// With an RTTM reference (who spoke when) it also reports how much speech went
// to the wrong speaker; without one it lists speaker counts and timing only.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');
const { toTurns, int16ToFloat32 } = require('../src/diarize.js');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const [value] = args.splice(i, 2).slice(1);
  return value;
};
const modelsDir = opt('models');
const threadsList = opt('threads', '4,8').split(',').map(Number);
const thresholds = opt('thresholds', '0.6,0.7,0.8,0.9,1.0').split(',').map(Number);
const numSpeakers = Number(opt('speakers', '0'));
if (!modelsDir || args.length === 0) {
  console.error('usage: node scripts/diarize-eval.mjs --models <dir> [--threads 4,8] [--thresholds ...] [--speakers N] file.wav[:ref.rttm] ...');
  process.exit(1);
}

function readAudio(file) {
  const buf = fs.readFileSync(file);
  if (file.endsWith('.pcm')) return int16ToFloat32(buf);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`${file}: not a WAV file`);
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    if (id === 'data') {
      if (!fmt || fmt.channels !== 1 || fmt.rate !== 16000 || fmt.bits !== 16) throw new Error(`${file}: needs 16 kHz mono 16-bit (got ${JSON.stringify(fmt)})`);
      return int16ToFloat32(buf.subarray(pos + 8, pos + 8 + size));
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error(`${file}: no audio data`);
}

function readRttm(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('SPEAKER')).map((l) => {
    const f = l.trim().split(/\s+/);
    return { startMs: Math.round(Number(f[3]) * 1000), endMs: Math.round((Number(f[3]) + Number(f[4])) * 1000), speaker: f[7] };
  });
}

// 10 ms frames. missed = reference speech with no hypothesis speaker;
// confusion = reference speech given to the wrong speaker after the best
// one-to-one mapping of hypothesis to reference speakers (greedy by overlap).
function score(ref, hyp, totalMs) {
  const frames = Math.ceil(totalMs / 10);
  const label = (turns) => {
    const out = Array.from({ length: frames }, () => new Set());
    for (const t of turns) for (let f = Math.floor(t.startMs / 10); f < Math.min(frames, Math.ceil(t.endMs / 10)); f++) out[f].add(t.speaker);
    return out;
  };
  const r = label(ref);
  const h = label(hyp);
  const overlap = new Map();
  for (let f = 0; f < frames; f++) for (const a of r[f]) for (const b of h[f]) overlap.set(`${a}\u0000${b}`, (overlap.get(`${a}\u0000${b}`) ?? 0) + 1);
  const map = new Map();
  const used = new Set();
  for (const [key] of [...overlap].sort((x, y) => y[1] - x[1])) {
    const [a, b] = key.split('\u0000');
    if (map.has(b) || used.has(a)) continue;
    map.set(b, a);
    used.add(a);
  }
  let speech = 0;
  let missed = 0;
  let confused = 0;
  for (let f = 0; f < frames; f++) {
    if (r[f].size === 0) continue;
    speech++;
    if (h[f].size === 0) missed++;
    else if (![...h[f]].some((b) => r[f].has(map.get(String(b))))) confused++;
  }
  const pct = (n) => `${((100 * n) / Math.max(1, speech)).toFixed(1)}%`;
  return { missed: pct(missed), confusion: pct(confused) };
}

const embeddings = fs.readdirSync(modelsDir).filter((f) => f.endsWith('.onnx') && f !== 'segmentation.onnx');
const rows = [];
for (const spec of args) {
  const [audioFile, rttmFile] = spec.split(/:(?![\\/])/);
  const samples = readAudio(audioFile);
  const audioMs = (samples.length / 16000) * 1000;
  const ref = rttmFile ? readRttm(rttmFile) : null;
  const expected = ref ? new Set(ref.map((t) => t.speaker)).size : '?';
  for (const embedding of embeddings) {
    for (const threads of threadsList) {
      const sd = new sherpa.OfflineSpeakerDiarization({
        segmentation: { pyannote: { model: path.join(modelsDir, 'segmentation.onnx') }, numThreads: threads },
        embedding: { model: path.join(modelsDir, embedding), numThreads: threads },
        clustering: { numClusters: numSpeakers, threshold: thresholds[0] },
        minDurationOn: 0.2,
        minDurationOff: 0.5,
      });
      // Only the first run per model and thread count is timed for speed.
      for (const [i, threshold] of thresholds.entries()) {
        sd.setConfig({ clustering: { numClusters: numSpeakers, threshold } });
        const t0 = performance.now();
        const turns = toTurns(sd.process(samples));
        const ms = performance.now() - t0;
        const found = new Set(turns.map((t) => t.speaker)).size;
        rows.push({
          file: path.basename(audioFile),
          embedding: embedding.replace(/^3dspeaker_speech_|_16k\.onnx$/g, ''),
          threads,
          threshold,
          speakers: `${found}/${expected}`,
          ...(ref ? score(ref, turns, audioMs) : {}),
          ...(i === 0 ? { seconds: (ms / 1000).toFixed(1), 'per hour of audio': `${((ms / audioMs) * 60).toFixed(1)} min` } : {}),
        });
      }
    }
  }
}
console.table(rows);
