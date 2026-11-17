import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import meetings from '../src/meetings.js';

const { MeetingStore, cleanTitle, safeFileTitle } = meetings;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'recio-'));
const files = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
const SUMMARY = {
  title: 'Meeting: "Release delay and launch pricing."',
  overview: 'Release moves to May 3.',
  topics: [{ topic: 'Release', points: ['Moved to May 3'] }],
  decisions: ['Keep 9 euros at launch'],
  action_items: [],
  open_questions: [],
};

test('titles are cleaned of quotes, prefixes and trailing periods', () => {
  assert.equal(cleanTitle(SUMMARY.title), 'Release delay and launch pricing');
  assert.equal(cleanTitle('   '), null);
});

test('file titles drop characters Windows forbids and reserved names', () => {
  assert.equal(safeFileTitle('Q3: plan / budget?'), 'Q3 plan budget');
  assert.equal(safeFileTitle('CON'), 'Untitled recording');
  assert.equal(safeFileTitle('dots...'), 'dots');
});

test('a recording is untitled until summarized, then renamed after its topic', () => {
  const root = tmp();
  const store = new MeetingStore(root);
  const id = '2026-10-20T19-08-12-610Z';
  store.create(id, '2026-10-20T19:08:12.610Z');
  store.appendChunk(id, { source: 'system', text: 'We move the release.', startMs: 1000, isFinal: true });
  store.finish(id, '2026-10-20T19:20:12.610Z');
  const [untitled] = files(root);
  assert.match(untitled, / – Untitled recording\.md$/);

  const meta = store.setSummary(id, SUMMARY);
  assert.equal(meta.title, 'Release delay and launch pricing');
  assert.deepEqual(files(root), [meta.file]);
  assert.match(meta.file, /^\d{4}-\d{2}-\d{2} \d{2}\.\d{2} – Release delay and launch pricing\.md$/);
  const doc = fs.readFileSync(path.join(root, meta.file), 'utf8');
  assert.match(doc, /^# Release delay and launch pricing\n/);
  assert.match(doc, /## Decisions[\s\S]*## Transcript\n\n\*\*Them\*\* \[0:01\]: We move the release\./);
});

test('two meetings with the same topic and minute do not overwrite each other', () => {
  const root = tmp();
  const store = new MeetingStore(root);
  for (const id of ['2026-10-20T19-08-01-000Z', '2026-10-20T19-08-30-000Z']) {
    store.create(id, id.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z/, 'T$1:$2:$3.$4Z'));
    store.setSummary(id, SUMMARY);
  }
  const names = files(root);
  assert.equal(names.length, 2);
  assert.ok(names.some((n) => n.endsWith('pricing (2).md')));
});

test('list is newest first and flags summaries', () => {
  const root = tmp();
  const store = new MeetingStore(root);
  store.create('2026-10-19T10-00-00-000Z', '2026-10-19T10:00:00.000Z');
  store.create('2026-10-20T10-00-00-000Z', '2026-10-20T10:00:00.000Z');
  store.setSummary('2026-10-19T10-00-00-000Z', SUMMARY);
  assert.deepEqual(store.list().map((m) => [m.id.slice(0, 10), m.hasSummary]), [['2026-10-20', false], ['2026-10-19', true]]);
});

test('flat files from the earlier layout are migrated without deleting anything', () => {
  const root = tmp();
  const id = '2026-10-20T19-29-34-394Z';
  fs.writeFileSync(path.join(root, `${id}.jsonl`), JSON.stringify({ source: 'microphone', text: 'Hi', startMs: 0, endMs: 61000 }) + '\n');
  fs.writeFileSync(path.join(root, `${id}.md`), '# old');
  fs.writeFileSync(path.join(root, `${id}.summary.json`), JSON.stringify(SUMMARY));
  const store = new MeetingStore(root);
  assert.equal(store.migrateFlat(), 1);
  assert.deepEqual(fs.readdirSync(path.join(root, '.data', id)).sort(), ['legacy-transcript.md', 'meta.json', 'summary.json', 'transcript.jsonl']);
  const [meta] = store.list();
  assert.equal(meta.title, 'Release delay and launch pricing');
  assert.equal(new Date(meta.endedAt) - new Date(meta.startedAt), 61000);
  assert.equal(store.migrateFlat(), 0);
});
