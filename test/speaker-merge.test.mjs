import { test } from 'node:test';
import assert from 'node:assert/strict';
import merge from '../src/speaker-merge.js';

const { cosine, speakerDurations, clusterAudio, planMerges, applyMerges, mergeSpeakers } = merge;
const turn = (startS, endS, speaker) => ({ startMs: startS * 1000, endMs: endS * 1000, speaker });
const durations = (obj) => new Map(Object.entries(obj).map(([k, v]) => [Number(k), v * 1000]));
const embeddings = (obj) => new Map(Object.entries(obj).map(([k, v]) => [Number(k), Float32Array.from(v)]));

test('cosine similarity', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 0]), 0);
});

test('speech per speaker is summed', () => {
  assert.deepEqual([...speakerDurations([turn(0, 2, 0), turn(2, 3, 1), turn(5, 9, 0)])], [[0, 6000], [1, 1000]]);
});

test('a speaker\'s audio is cut from the samples, longest pieces first, capped', () => {
  const samples = Float32Array.from({ length: 16000 * 10 }, (_, i) => i);
  const audio = clusterAudio([turn(0, 1, 0), turn(2, 5, 0), turn(6, 7, 1)], 0, samples, 3500);
  assert.equal(audio.length, 16000 * 3.5);
  assert.equal(audio[0], 32000, 'starts with the 3 s piece at 2 s');
  assert.equal(audio[48000], 0, 'then the 1 s piece, cut to the cap');
});

test('tiny speakers move to the most similar real speaker', () => {
  const map = planMerges({
    durations: durations({ 0: 100, 1: 60, 2: 2, 3: 4 }),
    embeddings: embeddings({ 0: [1, 0], 1: [0, 1], 2: [0.1, 1], 3: [1, 0.2] }),
    minMs: 5000,
  });
  assert.deepEqual([...map].sort(), [[2, 1], [3, 0]]);
});

test('tiny speakers go first, so two real voices are not joined because of noise', () => {
  // 0 and 1 are real and fairly alike; 2 and 3 are short noise unlike either.
  const plan = (minMs) => planMerges({
    durations: durations({ 0: 150, 1: 60, 2: 5, 3: 3 }),
    embeddings: embeddings({ 0: [1, 0.3, 0], 1: [0.3, 1, 0], 2: [0, 0, 1], 3: [-1, 0, 0] }),
    minMs,
    count: 3,
  });
  assert.equal(plan(0).get(1), 0, 'without the tiny step the real voices merge');
  const map = plan(4000);
  assert.equal(map.has(1), false, 'with it they stay apart');
  assert.equal(new Set([0, 1, 2, 3].map((s) => map.get(s) ?? s)).size, 3);
});

test('similar speakers are joined above the similarity, the larger keeps its number', () => {
  const map = planMerges({
    durations: durations({ 0: 30, 1: 80, 2: 50 }),
    embeddings: embeddings({ 0: [1, 0.05], 1: [1, 0], 2: [0, 1] }),
    similarity: 0.9,
  });
  assert.deepEqual([...map], [[0, 1]]);
});

test('a known count joins until that many are left, and never below it', () => {
  const emb = embeddings({ 0: [1, 0, 0], 1: [0.9, 0.1, 0], 2: [0, 1, 0], 3: [0, 0, 1] });
  const d = durations({ 0: 50, 1: 40, 2: 30, 3: 20 });
  assert.deepEqual([...planMerges({ durations: d, embeddings: emb, count: 3 })], [[1, 0]]);
  assert.equal(planMerges({ durations: d, embeddings: emb, count: 4, similarity: 0.5, minMs: 25000 }).size, 0);
});

test('speakers without an embedding are left alone', () => {
  const map = planMerges({ durations: durations({ 0: 100, 1: 1 }), embeddings: embeddings({ 0: [1, 0] }), minMs: 5000 });
  assert.equal(map.size, 0);
});

test('merged turns are relabelled, renumbered and joined when back to back', () => {
  const turns = [turn(0, 2, 5), turn(2.2, 3, 7), turn(4, 6, 9), turn(7, 8, 7)];
  assert.deepEqual(applyMerges(turns, new Map([[7, 5]])), [
    { startMs: 0, endMs: 3000, speaker: 0 },
    { startMs: 4000, endMs: 6000, speaker: 1 },
    { startMs: 7000, endMs: 8000, speaker: 0 },
  ]);
});

test('the share cut-off scales with the recording and the pass is off by default', () => {
  const turns = [turn(0, 90, 0), turn(90, 96, 1), turn(96, 100, 2)];
  // Speaker 0's audio is silent, 1 and 2 share a voice (value 1).
  const samples = new Float32Array(16000 * 100).fill(1, 16000 * 90);
  const embed = (audio) => Float32Array.from([audio[0], 1 - audio[0]]);
  assert.equal(mergeSpeakers(turns, samples, embed), turns);
  const merged = mergeSpeakers(turns, samples, embed, { minMs: 3000, minShare: 0.05 });
  assert.deepEqual(merged.map((t) => t.speaker), [0, 1], '4 s is under 5% of 100 s, 6 s is not');
});
