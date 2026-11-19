import { test } from 'node:test';
import assert from 'node:assert/strict';
import fmt from '../src/summary-format.js';
import sp from '../src/speakers.js';

test('the number of topics scales with the length', () => {
  assert.deepEqual(fmt.topicRange(5), [3, 5]);
  assert.deepEqual(fmt.topicRange(0), [3, 5]);
  assert.deepEqual(fmt.topicRange(30), [4, 7]);
  assert.deepEqual(fmt.topicRange(90), [5, 9]);
  assert.match(fmt.systemPrompt('en', { minutes: 5 }), /3 to 5 topics for this 5-minute recording/);
  assert.match(fmt.mergePrompt([{}], 'meeting', 60), /5 to 9 topics in total/);
});

test('the schema caps topics and points while the model writes, without changing the shared schema', () => {
  const s = fmt.schemaFor('meeting', 5);
  assert.equal(s.properties.topics.maxItems, 5);
  assert.equal(s.properties.topics.items.properties.points.maxItems, 5);
  assert.equal(fmt.schemaFor('meeting', 30).properties.topics.maxItems, 7);
  assert.equal(fmt.SUMMARY_SCHEMA.properties.topics.maxItems, undefined);
});

test('the prompt names the speaker labels to use as owners', () => {
  const chunks = [
    { source: 'microphone', text: 'Hi.', startMs: 0 },
    { source: 'system', text: 'Hello.', startMs: 1000, speaker: 'Gary' },
    { source: 'system', text: 'Yes.', startMs: 2000, speaker: 'Speaker 2' },
    { source: 'system', text: 'Hm.', startMs: 3000 },
  ];
  const ctx = fmt.speakerContext(chunks);
  assert.deepEqual(ctx, { others: ['Gary', 'Speaker 2'], them: true });
  const prompt = fmt.systemPrompt('en', ctx);
  assert.match(prompt, /are "Gary", "Speaker 2"; "Them" is someone on the computer audio who could not be told apart\./);
  assert.match(prompt, /use these labels exactly as written/);
  assert.match(fmt.systemPrompt('en', { others: ['Gary'], them: false }), /are "Gary"\. A label/);
  assert.match(fmt.systemPrompt('en'), /"Them" is everyone heard through the computer audio/, 'no speakers: as before');
});

test('the prompt only allows real commitments as action items', () => {
  const p = fmt.systemPrompt('en');
  assert.match(p, /only when a speaker explicitly committed/);
  assert.match(p, /an empty list is normal/);
  assert.match(p, /Never make a topic about the conversation itself/);
  assert.match(p, /humour in an ad campaign/);
});

test('length in minutes comes from the chunk times', () => {
  assert.equal(fmt.minutesOf([{ startMs: 60000, endMs: 90000 }, { startMs: 300000, endMs: 360000 }]), 5);
  assert.equal(fmt.minutesOf([]), 0);
});

test('meta topics, repeated points and empty topics are removed after the model', () => {
  const tidy = fmt.tidyMeetingSummary({
    topics: [
      { topic: 'Release plan', points: ['Release moves to May 3.', 'Budget is 9k.'] },
      { topic: 'Tone and style', points: ['Friendly.'] },
      { topic: 'Budget', points: ['The budget is 9k.', 'Hiring two people.'] },
      { topic: 'Stimmung', points: ['gut'] },
      { topic: 'Stimmung im Team nach dem Umzug', points: ['Besser seit dem Umzug.'] },
      { topic: 'Group appreciation and gratitude', points: ['Thanks all round.'] },
      { topic: 'Humour in the spring campaign', points: ['Jokes tested well with under-30s.'] },
      { topic: 'Repeat', points: ['Release moves to May 3'] },
    ],
  });
  assert.deepEqual(tidy.topics, [
    { topic: 'Release plan', points: ['Release moves to May 3.', 'Budget is 9k.'] },
    { topic: 'Budget', points: ['Hiring two people.'] },
    { topic: 'Stimmung im Team nach dem Umzug', points: ['Besser seit dem Umzug.'] },
    { topic: 'Humour in the spring campaign', points: ['Jokes tested well with under-30s.'] },
  ]);
  const onlyMeta = fmt.tidyMeetingSummary({ topics: [{ topic: 'Tone and style', points: ['Calm.'] }] });
  assert.equal(onlyMeta.topics.length, 1, 'never removes every topic');
});

test('a rename swaps whole labels in an existing summary', () => {
  const summary = {
    title: 'Speaker 1 plans the launch',
    overview: 'Speaker 1 and Speaker 10 talked; Speaker 1’s plan won.',
    topics: [{ topic: 'Plan', points: ['Speaker 1 wants May.'] }],
    action_items: [{ task: 'Send deck', owner: 'Speaker 1', due: '' }, { task: 'Book room', owner: 'Speaker 10', due: '' }],
    kind: 'meeting',
  };
  const out = sp.replaceLabel(summary, 'Speaker 1', 'Alan');
  assert.equal(out.title, 'Alan plans the launch');
  assert.equal(out.overview, 'Alan and Speaker 10 talked; Alan’s plan won.');
  assert.deepEqual(out.action_items.map((a) => a.owner), ['Alan', 'Speaker 10']);
  assert.equal(out.kind, 'meeting');
  assert.equal(sp.replaceLabel(summary, 'Speaker 1', 'Speaker 1'), summary);
  assert.equal(sp.replaceLabel({ a: 'Cost $5 (Speaker 1)' }, 'Speaker 1', '$& x').a, 'Cost $5 ($& x)', 'replacement text is literal');
});
