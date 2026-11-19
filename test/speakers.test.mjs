import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sp from '../src/speakers.js';
import fmt from '../src/summary-format.js';
import meetings from '../src/meetings.js';
import exportFormat from '../src/export-format.js';

const { assignSpeakers, createSpeakers, labelChunks, speakerList, renameSpeaker, mergeSpeaker, unmergeSpeaker, cleanName, resolve } = sp;
const { MeetingStore } = meetings;
const LABELS = { microphone: 'Me', system: 'Them' };
let n = 0;
const chunk = (source, startS, endS, text = `line ${++n}`) => ({ id: `${source}-${n}`, source, text, startMs: startS * 1000, endMs: endS * 1000, isFinal: true });
const turn = (startS, endS, speaker) => ({ startMs: startS * 1000, endMs: endS * 1000, speaker });

test('a system chunk gets the speaker it overlaps most', () => {
  const c = chunk('system', 10, 20);
  assert.deepEqual(assignSpeakers([c], [turn(8, 12, 0), turn(12, 20, 1)]), { [c.id]: 1 });
});

test('overlap from several turns of one speaker adds up', () => {
  const c = chunk('system', 0, 10);
  assert.deepEqual(assignSpeakers([c], [turn(0, 3, 0), turn(3, 7, 1), turn(7, 10, 0)]), { [c.id]: 0 });
});

test('on a tie the speaker who spoke first in the chunk wins', () => {
  const c = chunk('system', 0, 10);
  assert.deepEqual(assignSpeakers([c], [turn(5, 10, 0), turn(0, 5, 1)]), { [c.id]: 1 });
});

test('no overlap keeps "Them"; microphone chunks are never changed', () => {
  const them = chunk('system', 30, 32);
  const me = chunk('microphone', 0, 5);
  const assigned = assignSpeakers([them, me], [turn(0, 10, 0)]);
  assert.deepEqual(assigned, {});
  const labelled = labelChunks([them, me], createSpeakers([them, me], [turn(0, 10, 0)]));
  assert.equal(labelled[0].speaker, undefined);
  assert.equal(labelled[1].speaker, undefined);
});

test('a single speaker labels every overlapping system chunk "Speaker 1"', () => {
  const chunks = [chunk('system', 0, 4), chunk('microphone', 4, 6), chunk('system', 6, 9)];
  const data = createSpeakers(chunks, [turn(0, 10, 0)]);
  assert.deepEqual(labelChunks(chunks, data).map((c) => c.speaker ?? LABELS[c.source]), ['Speaker 1', 'Me', 'Speaker 1']);
});

test('a chunk without endMs counts as a point in time', () => {
  const c = { id: 'system-x', source: 'system', text: 'hi', startMs: 5000 };
  assert.deepEqual(assignSpeakers([c], [turn(0, 10, 2)]), {});
});

test('names are cleaned and capped', () => {
  assert.equal(cleanName('  **Alan**\n Shearer '), 'Alan Shearer');
  assert.equal(cleanName('x'.repeat(60)).length, 40);
});

function threeSpeakers() {
  const chunks = [chunk('system', 0, 5), chunk('system', 5, 10), chunk('system', 10, 15), chunk('microphone', 15, 16)];
  return { chunks, data: createSpeakers(chunks, [turn(0, 5, 0), turn(5, 10, 1), turn(10, 15, 2)]) };
}

test('renaming changes every line of that speaker; blank resets it', () => {
  const { chunks, data } = threeSpeakers();
  const named = renameSpeaker(data, 1, 'Alan');
  assert.deepEqual(labelChunks(chunks, named).map((c) => c.speaker ?? 'Me'), ['Speaker 1', 'Alan', 'Speaker 3', 'Me']);
  assert.deepEqual(labelChunks(chunks, renameSpeaker(named, 1, '  ')).map((c) => c.speaker ?? 'Me'), ['Speaker 1', 'Speaker 2', 'Speaker 3', 'Me']);
});

test('names must not clash with a channel or another speaker', () => {
  const { data } = threeSpeakers();
  assert.throws(() => renameSpeaker(data, 0, 'me'), /channel/);
  assert.throws(() => renameSpeaker(data, 0, 'Speaker 2'), /merge them instead/);
  assert.throws(() => renameSpeaker(renameSpeaker(data, 0, 'Alan'), 1, 'alan'), /merge them instead/);
  assert.throws(() => renameSpeaker(data, 7, 'Gary'), /Unknown speaker/);
});

test('merging moves lines, keeps the other numbers and can be undone', () => {
  const { chunks, data } = threeSpeakers();
  const merged = mergeSpeaker(renameSpeaker(data, 0, 'Alan'), 2, 0);
  assert.deepEqual(labelChunks(chunks, merged).map((c) => c.speaker ?? 'Me'), ['Alan', 'Speaker 2', 'Alan', 'Me']);
  const list = speakerList(chunks, merged);
  assert.deepEqual(list.map((s) => [s.id, s.label, s.mergedInto, s.merged, s.lines]), [
    [0, 'Alan', null, [2], 2],
    [1, 'Speaker 2', null, [], 1],
    [2, 'Alan', 0, [], 0],
  ]);
  assert.equal(list[0].ms, 10000);
  const undone = unmergeSpeaker(merged, 2);
  assert.deepEqual(labelChunks(chunks, undone).map((c) => c.speaker ?? 'Me'), ['Alan', 'Speaker 2', 'Speaker 3', 'Me']);
});

test('merges follow chains and refuse loops or repeats', () => {
  const { data } = threeSpeakers();
  const chain = mergeSpeaker(mergeSpeaker(data, 2, 1), 1, 0);
  assert.equal(resolve(chain, 2), 0);
  assert.throws(() => mergeSpeaker(data, 1, 1), /itself/);
  assert.throws(() => mergeSpeaker(mergeSpeaker(data, 1, 0), 1, 2), /already merged/);
  assert.throws(() => mergeSpeaker(mergeSpeaker(data, 1, 0), 0, 1), /itself/, 'into a merged speaker means into its target');
  assert.throws(() => renameSpeaker(mergeSpeaker(data, 1, 0), 1, 'Gary'), /merged/);
  assert.equal(resolve({ mergedInto: { 0: 1, 1: 0 } }, 0), 0, 'a corrupt loop does not hang');
});

test('the transcript for the summary starts a new turn when the speaker changes', () => {
  const { chunks, data } = threeSpeakers();
  const text = fmt.formatTranscript(labelChunks(chunks, renameSpeaker(data, 0, 'Alan')), LABELS);
  assert.equal(text, [
    '[0:00] Alan: ' + chunks[0].text,
    '[0:05] Speaker 2: ' + chunks[1].text,
    '[0:10] Speaker 3: ' + chunks[2].text,
    '[0:15] Me: ' + chunks[3].text,
  ].join('\n'));
  const merged = fmt.formatTranscript(labelChunks(chunks, mergeSpeaker(data, 1, 0)), LABELS);
  assert.match(merged, /^\[0:00\] Speaker 1: line \d+ line \d+\n\[0:10\] Speaker 3:/, 'same speaker again is one turn');
});

test('old recordings without speakers render exactly as before', () => {
  const chunks = [chunk('system', 0, 2, 'Hello.'), chunk('system', 2, 4, 'Yes.'), chunk('microphone', 4, 5, 'Hi.')];
  assert.equal(labelChunks(chunks, null), chunks);
  assert.equal(fmt.formatTranscript(chunks, LABELS), '[0:00] Them: Hello. Yes.\n[0:04] Me: Hi.');
});

test('the store keeps labels in speakers.json, updates the document and leaves the transcript alone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recio-spk-'));
  const store = new MeetingStore(root);
  const id = '2026-11-19T10-15-29-406Z';
  store.create(id, '2026-11-19T10:15:29.406Z');
  const { chunks } = threeSpeakers();
  for (const c of chunks) store.appendChunk(id, c);
  store.finish(id, '2026-11-19T10:20:00.000Z');
  const transcriptBefore = fs.readFileSync(path.join(root, '.data', id, 'transcript.jsonl'), 'utf8');
  const doc = () => fs.readFileSync(path.join(root, store.readMeta(id).file), 'utf8');
  assert.match(doc(), /\*\*Them\*\* \[0:00\]/);
  assert.deepEqual(store.get(id).speakers, []);

  store.setSpeakerTurns(id, [turn(0, 5, 0), turn(5, 10, 1), turn(10, 15, 2)]);
  assert.match(doc(), /\*\*Speaker 1\*\* \[0:00\][\s\S]*\*\*Speaker 3\*\* \[0:10\][\s\S]*\*\*Me\*\* \[0:15\]/);

  store.renameSpeaker(id, 0, 'Alan');
  store.mergeSpeaker(id, 2, 0);
  assert.match(doc(), /\*\*Alan\*\* \[0:00\][\s\S]*\*\*Speaker 2\*\* \[0:05\][\s\S]*\*\*Alan\*\* \[0:10\]/);
  const meeting = store.get(id);
  assert.deepEqual(meeting.chunks.map((c) => c.speaker ?? 'Me'), ['Alan', 'Speaker 2', 'Alan', 'Me']);
  assert.deepEqual(store.labeledChunks(id).map((c) => c.speaker ?? 'Me'), ['Alan', 'Speaker 2', 'Alan', 'Me']);
  assert.equal(meeting.speakers.filter((s) => s.mergedInto === null).length, 2);
  assert.match(exportFormat.toPlainText(meeting, { includeTranscript: true }), /\] Alan: /);

  assert.equal(fs.readFileSync(path.join(root, '.data', id, 'transcript.jsonl'), 'utf8'), transcriptBefore);
  assert.equal(fs.existsSync(path.join(root, '.data', id, 'speakers.json.tmp')), false);
  assert.throws(() => store.renameSpeaker('2026-11-19T10-00-00-000Z', 0, 'x'));
});

test('renaming in the store updates an existing summary and its title at once; merges do not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recio-spk-'));
  const store = new MeetingStore(root);
  const id = '2026-11-19T11-33-32-611Z';
  store.create(id, '2026-11-19T11:33:32.611Z');
  const { chunks } = threeSpeakers();
  for (const c of chunks) store.appendChunk(id, c);
  store.finish(id, '2026-11-19T11:40:00.000Z');
  store.setSpeakerTurns(id, [turn(0, 5, 0), turn(5, 10, 1), turn(10, 15, 2)]);
  store.setSummary(id, {
    title: 'Speaker 1 on the derby', overview: 'Speaker 1 disagreed with Speaker 2.', topics: [], decisions: [],
    action_items: [{ task: 'Check footage', owner: 'Speaker 2', due: '' }], open_questions: [], kind: 'meeting',
  });
  store.renameSpeaker(id, 0, 'Gary');
  store.renameSpeaker(id, 1, 'Micah');
  const s = store.readSummary(id);
  assert.equal(s.overview, 'Gary disagreed with Micah.');
  assert.equal(s.action_items[0].owner, 'Micah');
  assert.equal(store.readMeta(id).title, 'Gary on the derby');
  assert.match(store.readMeta(id).file, /Gary on the derby\.md$/);
  store.mergeSpeaker(id, 2, 0);
  assert.equal(store.readSummary(id).overview, 'Gary disagreed with Micah.', 'merge leaves the summary for Re-summarize');
  store.renameSpeaker(id, 0, '');
  assert.equal(store.readSummary(id).overview, 'Speaker 1 disagreed with Micah.', 'a reset puts the default label back');
});
