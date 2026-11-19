import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import diarize from '../src/diarize.js';
import speakerPackModule from '../src/speaker-pack.js';

const { Diarizer, parseSpeakerCount, int16ToFloat32, readPcmFloat32, toTurns, estimateMs, MIN_AUDIO_MS } = diarize;
const { SpeakerPack, ASSETS, EMBEDDINGS, EMBEDDING } = speakerPackModule;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'recio-diar-'));

test('number of speakers: blank or auto means detect, otherwise 1–10', () => {
  assert.equal(parseSpeakerCount(''), 0);
  assert.equal(parseSpeakerCount('  '), 0);
  assert.equal(parseSpeakerCount(undefined), 0);
  assert.equal(parseSpeakerCount('auto'), 0);
  assert.equal(parseSpeakerCount('3'), 3);
  assert.equal(parseSpeakerCount(10), 10);
  for (const bad of ['0', '11', '2.5', 'two', '-1']) assert.throws(() => parseSpeakerCount(bad), /1–10/);
});

test('Int16 PCM converts to floats in [-1, 1)', () => {
  const bytes = Buffer.from(Int16Array.from([0, 16384, -32768, 32767]).buffer);
  assert.deepEqual(Array.from(int16ToFloat32(bytes)), [0, 0.5, -1, 32767 / 32768]);
});

test('reading a PCM file in blocks gives the same samples as reading it at once', () => {
  const file = path.join(tmp(), 'a.pcm');
  const samples = Int16Array.from({ length: 700_001 }, (_, i) => ((i * 37) % 65536) - 32768);
  fs.writeFileSync(file, Buffer.from(samples.buffer));
  const floats = readPcmFloat32(file);
  assert.equal(floats.length, samples.length);
  assert.equal(floats[0], samples[0] / 32768);
  assert.equal(floats[524_288], samples[524_288] / 32768, 'across the 1 MB block border');
  assert.equal(floats.at(-1), samples.at(-1) / 32768);
});

test('segments become sorted turns on the recording timeline, speakers numbered by first appearance', () => {
  const turns = toTurns([
    { start: 4.0, end: 6.5, speaker: 2 },
    { start: 0.5, end: 3.25, speaker: 7 },
    { start: 7.0, end: 7.0, speaker: 9 }, // empty: dropped
    { start: 8.0, end: 9.0, speaker: 7 },
  ], 1500);
  assert.deepEqual(turns, [
    { startMs: 2000, endMs: 4750, speaker: 0 },
    { startMs: 5500, endMs: 8000, speaker: 1 },
    { startMs: 9500, endMs: 10500, speaker: 0 },
  ]);
  assert.deepEqual(toTurns([]), []);
});

test('the progress estimate grows with the audio and is never zero', () => {
  assert.equal(estimateMs(0), 1000);
  assert.ok(estimateMs(3_600_000) > estimateMs(60_000));
});

test('missing or very short audio returns no turns without starting the engine', async () => {
  const dir = tmp();
  const diarizer = new Diarizer();
  const models = { segmentation: 'none.onnx', embedding: 'none.onnx' };
  assert.deepEqual((await diarizer.run({ pcmFile: path.join(dir, 'missing.pcm'), models })).turns, []);
  const short = path.join(dir, 'short.pcm');
  fs.writeFileSync(short, Buffer.alloc(((MIN_AUDIO_MS - 100) * 16000 * 2) / 1000));
  const result = await diarizer.run({ pcmFile: short, models });
  assert.deepEqual(result.turns, []);
  assert.equal(diarizer.busy, false);
});

test('an engine error is reported, not thrown away', async () => {
  const dir = tmp();
  const pcmFile = path.join(dir, 'a.pcm');
  fs.writeFileSync(pcmFile, Buffer.alloc(16000 * 2 * 3));
  const diarizer = new Diarizer();
  await assert.rejects(diarizer.run({ pcmFile, models: { segmentation: path.join(dir, 'no-such.onnx'), embedding: path.join(dir, 'no-such.onnx') } }));
  assert.equal(diarizer.busy, false);
});

test('every speaker-pack file is pinned to a SHA-256 and the licences are included', () => {
  for (const asset of ASSETS) assert.match(asset.sha256, /^[0-9a-f]{64}$/, asset.target);
  assert.ok(ASSETS.some((a) => a.target.startsWith('licenses/') && /MIT/.test(a.target)));
  assert.ok(ASSETS.some((a) => a.target.startsWith('licenses/') && /Apache/.test(a.target)));
  assert.ok(ASSETS.some((a) => a.target === 'embedding.onnx' && a.sha256 === EMBEDDINGS[EMBEDDING].sha256));
  for (const asset of ASSETS) assert.match(asset.url, /^https:\/\/(huggingface\.co|github\.com|raw\.githubusercontent\.com)\/.+\/(resolve\/[0-9a-f]{40}|releases\/download|[^/]+\/[0-9a-f]{40})\//, asset.url);
});

// A stand-in for downloadFile: writes the bytes the test chooses for each URL.
const fakeDownload = (bodyFor) => async (url, dest) => {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bodyFor(url));
};

test('the speaker pack installs only after every file is verified', async () => {
  const root = tmp();
  const pack = new SpeakerPack(root);
  assert.equal(pack.isInstalled(), false);
  await assert.rejects(pack.install(() => {}, { download: fakeDownload(() => 'not the real model') }), /Checksum mismatch/);
  assert.equal(pack.isInstalled(), false);
  assert.equal(fs.existsSync(pack.embeddingPath), false);
});
