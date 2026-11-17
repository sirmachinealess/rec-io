import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOP, SAMPLE_RATE, Segmenter } from '../src/renderer/segmenter.js';

const silence = (seconds) => new Int16Array(Math.round(seconds * SAMPLE_RATE));
function tone(seconds, amplitude = 8000) {
  const out = new Int16Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE));
  return out;
}
// Feed in 100 ms frames, like the AudioWorklet does.
function feed(seg, audio) {
  const events = [];
  for (let i = 0; i < audio.length; i += 1600) events.push(...seg.push(audio.subarray(i, i + 1600)));
  return events;
}
const finals = (events) => events.filter((e) => e.type === 'final');

test('one utterance between silences gives one final with pre-roll', () => {
  const seg = new Segmenter();
  const events = feed(seg, silence(1));
  events.push(...feed(seg, tone(2)), ...feed(seg, silence(2)));
  const [f, ...rest] = finals(events);
  assert.equal(rest.length, 0);
  const startS = f.startSample / SAMPLE_RATE;
  const endS = f.endSample / SAMPLE_RATE;
  assert.ok(startS > 0.7 && startS < 1, `starts just before speech, got ${startS}`);
  assert.ok(endS > 3 && endS < 3.4, `ends shortly after speech, got ${endS}`);
  assert.equal(f.samples.length, f.endSample - f.startSample);
});

test('two utterances separated by a pause give two finals', () => {
  const seg = new Segmenter();
  const events = [...feed(seg, tone(1)), ...feed(seg, silence(1.5)), ...feed(seg, tone(1)), ...feed(seg, silence(1.5))];
  assert.equal(finals(events).length, 2);
});

test('a short pause inside speech does not split the segment', () => {
  const seg = new Segmenter();
  const events = [...feed(seg, tone(1)), ...feed(seg, silence(0.4)), ...feed(seg, tone(1)), ...feed(seg, silence(1.5))];
  assert.equal(finals(events).length, 1);
});

test('a click shorter than the minimum is ignored', () => {
  const seg = new Segmenter();
  const events = [...feed(seg, silence(0.5)), ...feed(seg, tone(0.1)), ...feed(seg, silence(1.5))];
  assert.equal(finals(events).length, 0);
});

test('continuous speech is cut at 25 seconds', () => {
  const seg = new Segmenter();
  const [first] = finals(feed(seg, tone(30)));
  assert.ok(first, 'expected a forced cut');
  assert.ok((first.endSample - first.startSample) / SAMPLE_RATE <= 25.01);
});

test('partials are emitted during long speech, and flush closes the open segment', () => {
  const seg = new Segmenter();
  const events = feed(seg, tone(4));
  assert.ok(events.some((e) => e.type === 'partial'));
  const flushed = seg.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].type, 'final');
  assert.equal(flushed[0].samples.length % HOP, 0);
});

test('quiet background noise is not speech', () => {
  const seg = new Segmenter();
  const noise = new Int16Array(SAMPLE_RATE * 3).map(() => Math.round((Math.random() - 0.5) * 200));
  assert.equal(finals(feed(seg, noise)).length + seg.flush().length, 0);
});
