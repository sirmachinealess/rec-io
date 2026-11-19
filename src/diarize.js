// Speaker separation for the system channel, run after Stop on the CPU in a
// worker thread (sherpa-onnx: pyannote segmentation + speaker embeddings +
// clustering), so the window stays responsive and the GPU stays free.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const SAMPLE_RATE = 16000;
const MAX_SPEAKERS = 10;
// Below this there is nothing useful to separate.
const MIN_AUDIO_MS = 2000;
// Clustering threshold: higher = fewer speakers. Tuned on test calls (see README).
const DEFAULT_THRESHOLD = 0.9;
// Measured on an i7-10700K (8 cores): see README for the timings.
const DEFAULT_THREADS = Math.max(1, Math.min(8, (os.availableParallelism?.() ?? os.cpus().length) - 1));
// Seconds of processing per second of audio, used only for the progress estimate.
const ESTIMATED_RTF = 0.06;

// "" / "auto" / 0 -> 0 (detect automatically); otherwise a whole number 1..10.
function parseSpeakerCount(value) {
  const text = String(value ?? '').trim();
  if (text === '' || text.toLowerCase() === 'auto') return 0;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > MAX_SPEAKERS) throw new Error(`Number of speakers must be 1–${MAX_SPEAKERS} or blank`);
  return n;
}

// Int16 little-endian PCM bytes -> Float32 samples in [-1, 1).
function int16ToFloat32(bytes, out = new Float32Array(Math.floor(bytes.length / 2)), offset = 0) {
  const n = Math.floor(bytes.length / 2);
  for (let i = 0; i < n; i++) out[offset + i] = bytes.readInt16LE(i * 2) / 32768;
  return out;
}

// Reads the whole PCM file as Float32 without holding a second copy in memory.
function readPcmFloat32(file) {
  const total = Math.floor(fs.statSync(file).size / 2);
  const out = new Float32Array(total);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let done = 0;
    while (done < total) {
      const read = fs.readSync(fd, buf, 0, Math.min(buf.length, (total - done) * 2), done * 2);
      if (read <= 0) break;
      int16ToFloat32(buf.subarray(0, read - (read % 2)), out, done);
      done += Math.floor(read / 2);
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

// sherpa-onnx segments ({ start, end, speaker } in seconds, file-relative) ->
// [{ startMs, endMs, speaker }] on the recording timeline, sorted by start, with
// speakers renumbered 0, 1, 2, … in order of first appearance.
function toTurns(segments, offsetMs = 0) {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  const ids = new Map();
  return sorted
    .filter((s) => s.end > s.start)
    .map((s) => {
      if (!ids.has(s.speaker)) ids.set(s.speaker, ids.size);
      return {
        startMs: offsetMs + Math.round(s.start * 1000),
        endMs: offsetMs + Math.round(s.end * 1000),
        speaker: ids.get(s.speaker),
      };
    });
}

function estimateMs(audioMs) {
  return Math.max(1000, audioMs * ESTIMATED_RTF);
}

class Diarizer {
  constructor() {
    this.worker = null;
  }

  get busy() {
    return Boolean(this.worker);
  }

  // Resolves { turns, speakers, audioMs, elapsedMs }. Returns no turns when the
  // file is missing or too short. Does not delete the file (the caller does).
  async run({ pcmFile, offsetMs = 0, numSpeakers = 0, threshold = DEFAULT_THRESHOLD, threads = DEFAULT_THREADS, models }) {
    if (this.worker) throw new Error('Speaker separation is already running');
    const audioMs = fs.existsSync(pcmFile) ? Math.round((fs.statSync(pcmFile).size / 2 / SAMPLE_RATE) * 1000) : 0;
    if (audioMs < MIN_AUDIO_MS) return { turns: [], speakers: 0, audioMs, elapsedMs: 0 };
    const started = Date.now();
    const config = {
      segmentation: { pyannote: { model: models.segmentation }, numThreads: threads },
      embedding: { model: models.embedding, numThreads: threads },
      clustering: { numClusters: numSpeakers, threshold },
      minDurationOn: 0.2,
      minDurationOff: 0.5,
    };
    const segments = await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'diarize-worker.js'), { workerData: { pcmFile, config } });
      this.worker = worker;
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        this.worker = null;
        fn(value);
      };
      worker.on('message', (msg) => (msg.error ? done(reject, new Error(msg.error)) : done(resolve, msg.segments)));
      worker.on('error', (err) => done(reject, err));
      worker.on('exit', (code) => done(reject, new Error(code === 1 ? 'Speaker separation was cancelled' : `Speaker separation stopped (exit ${code})`)));
    });
    const turns = toTurns(segments, offsetMs);
    return { turns, speakers: new Set(turns.map((t) => t.speaker)).size, audioMs, elapsedMs: Date.now() - started };
  }

  // Stops a running separation (app closing); run() then rejects.
  cancel() {
    this.worker?.terminate();
  }
}

module.exports = {
  Diarizer,
  parseSpeakerCount,
  int16ToFloat32,
  readPcmFloat32,
  toTurns,
  estimateMs,
  DEFAULT_THRESHOLD,
  DEFAULT_THREADS,
  MAX_SPEAKERS,
  MIN_AUDIO_MS,
};
