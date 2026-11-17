import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptStore } from '../src/renderer/transcript.js';

const chunk = (id, source, text, startMs, isFinal = false) => ({ id, source, text, startMs, endMs: startMs + 500, isFinal });

test('a revised partial replaces itself in place', () => {
  const s = new TranscriptStore();
  s.upsert(chunk('a', 'microphone', 'hel', 0));
  const out = s.upsert(chunk('a', 'microphone', 'hello there', 0, true));
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'hello there');
  assert.equal(out[0].isFinal, true);
});

test('chunks from two sources interleave by start time', () => {
  const s = new TranscriptStore();
  s.upsert(chunk('m1', 'microphone', 'first', 0, true));
  s.upsert(chunk('m2', 'microphone', 'third', 2000, true));
  const out = s.upsert(chunk('s1', 'system', 'second', 1000, true));
  assert.deepEqual(out.map((c) => c.text), ['first', 'second', 'third']);
});

test('an empty final removes the partial it replaces', () => {
  const s = new TranscriptStore();
  s.upsert(chunk('a', 'system', 'uh', 0));
  assert.deepEqual(s.upsert(chunk('a', 'system', '', 0, true)), []);
});

test('markdown export lists final chunks only', () => {
  const s = new TranscriptStore();
  s.upsert(chunk('a', 'microphone', 'hi', 61000, true));
  s.upsert(chunk('b', 'system', 'still talk', 62000));
  assert.equal(s.toMarkdown('T', { microphone: 'Me', system: 'Them' }), '# T\n\n**Me** [1:01]: hi\n');
});
