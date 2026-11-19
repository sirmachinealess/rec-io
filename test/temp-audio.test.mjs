import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tempAudioModule from '../src/temp-audio.js';
import { AudioBatcher } from '../src/renderer/audio-batcher.js';

const { TempAudio, MAX_APPEND_BYTES } = tempAudioModule;
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recio-audio-')), 'tmp');
const ID = '2026-11-19T09-30-00-000Z';
const samples = (...values) => Int16Array.from(values);
const readSamples = (file) => {
  const buf = fs.readFileSync(file);
  return Array.from(new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2));
};

test('appending creates the tmp folder and keeps samples in order', () => {
  const audio = new TempAudio(tmp());
  audio.append(ID, samples(1, -2, 3).buffer);
  audio.append(ID, samples(32767, -32768));
  audio.append(ID, Buffer.from(samples(7).buffer));
  assert.equal(path.basename(audio.path(ID)), `${ID}-system.pcm`);
  assert.deepEqual(readSamples(audio.path(ID)), [1, -2, 3, 32767, -32768, 7]);
});

test('an empty batch writes nothing', () => {
  const audio = new TempAudio(tmp());
  audio.append(ID, new ArrayBuffer(0));
  assert.equal(audio.exists(ID), false);
});

test('bad ids and bad data are refused', () => {
  const audio = new TempAudio(tmp());
  assert.throws(() => audio.append('..\\..\\evil', samples(1).buffer), /invalid meeting id/);
  assert.throws(() => audio.append(ID, 'text'), /binary/);
  assert.throws(() => audio.append(ID, new ArrayBuffer(3)), /whole Int16/);
  assert.throws(() => audio.append(ID, new ArrayBuffer(MAX_APPEND_BYTES + 2)), /too large/);
  assert.equal(audio.exists(ID), false);
});

test('remove deletes the file and is safe to repeat', () => {
  const audio = new TempAudio(tmp());
  audio.append(ID, samples(1, 2).buffer);
  audio.remove(ID);
  audio.remove(ID);
  assert.equal(audio.exists(ID), false);
});

test('cleanup removes every leftover in tmp and nothing outside it', () => {
  const dir = tmp();
  const audio = new TempAudio(dir);
  assert.equal(audio.cleanup(), 0, 'missing folder is fine');
  audio.append(ID, samples(1).buffer);
  audio.append('2026-11-18T08-00-00-000Z', samples(2).buffer);
  fs.mkdirSync(path.join(dir, 'stray'));
  const outside = path.join(path.dirname(dir), 'keep.txt');
  fs.writeFileSync(outside, 'x');
  assert.equal(audio.cleanup(), 3);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(fs.existsSync(outside), true);
});

test('the batcher sends ~1 s batches in order and flushes the rest', () => {
  const sent = [];
  const batcher = new AudioBatcher((buf) => sent.push(Array.from(new Int16Array(buf))), 4);
  batcher.push(samples(1, 2).buffer);
  assert.equal(sent.length, 0);
  batcher.push(samples(3, 4, 5).buffer);
  assert.deepEqual(sent, [[1, 2, 3, 4, 5]]);
  batcher.push(samples(6).buffer);
  batcher.flush();
  batcher.flush();
  assert.deepEqual(sent, [[1, 2, 3, 4, 5], [6]]);
});

test('the batcher copies frames, so the caller can reuse its buffer', () => {
  const sent = [];
  const batcher = new AudioBatcher((buf) => sent.push(Array.from(new Int16Array(buf))), 100);
  const frame = samples(1, 2);
  batcher.push(frame.buffer);
  frame[0] = 99;
  batcher.flush();
  assert.deepEqual(sent, [[1, 2]]);
});

test('batches written through TempAudio reproduce the original stream', () => {
  const audio = new TempAudio(tmp());
  const batcher = new AudioBatcher((buf) => audio.append(ID, buf), 16000);
  const stream = [];
  for (let f = 0; f < 25; f++) {
    const frame = new Int16Array(1600).map((_, i) => (f * 1600 + i) % 30000);
    stream.push(...frame);
    batcher.push(frame.buffer);
  }
  batcher.flush();
  assert.deepEqual(readSamples(audio.path(ID)), stream);
});
