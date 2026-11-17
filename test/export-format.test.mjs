import { test } from 'node:test';
import assert from 'node:assert/strict';
import exp from '../src/export-format.js';

const meeting = {
  meta: { id: 'x', title: 'Release delay and launch pricing', startedAt: '2026-10-20T19:08:00.000Z', endedAt: '2026-10-20T19:20:00.000Z', file: 'f.md' },
  summary: {
    title: 'Release delay and launch pricing',
    overview: 'Release moves to May 3.',
    topics: [{ topic: 'Release', points: ['Moved to May 3', 'Marta fixes crashes'] }],
    decisions: ['Keep 9 euros at launch'],
    action_items: [{ task: 'Send design doc', owner: 'Me', due: 'Thursday' }, { task: 'Book room', owner: '', due: '' }],
    open_questions: ['Berlin or remote?'],
  },
  chunks: [{ source: 'system', text: 'We move the release.', startMs: 1000 }, { source: 'microphone', text: 'Okay.', startMs: 4000 }],
};

test('text export has every section and leaves the transcript out by default', () => {
  const txt = exp.toPlainText(meeting);
  for (const s of ['Release delay and launch pricing\r\n', 'SUMMARY', 'TOPICS', '  - Moved to May 3', 'DECISIONS', '  [ ] Send design doc (Me, due Thursday)', '  [ ] Book room\r\n', 'OPEN QUESTIONS']) {
    assert.ok(txt.includes(s), `missing ${JSON.stringify(s)}`);
  }
  assert.ok(!txt.includes('TRANSCRIPT'));
  assert.ok(!/[^\r]\n/.test(txt), 'uses Windows line endings');
});

test('text export can include the transcript', () => {
  const txt = exp.toPlainText(meeting, { includeTranscript: true });
  assert.ok(txt.includes('TRANSCRIPT\r\n[0:01] Them: We move the release.\r\n[0:04] Me: Okay.'));
});

test('text export without a summary says so', () => {
  const txt = exp.toPlainText({ ...meeting, summary: null, meta: { ...meeting.meta, title: null } });
  assert.match(txt, /^Untitled recording\r\n/);
  assert.ok(txt.includes('No summary yet.'));
});

test('print page escapes transcript and summary text', () => {
  const evil = { ...meeting, chunks: [{ source: 'system', text: '<img src=x onerror=alert(1)>', startMs: 0 }] };
  const html = exp.toPrintHtml(evil, { includeTranscript: true });
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('print page tags speakers orange and named people blue', () => {
  const html = exp.toPrintHtml({ ...meeting, summary: { ...meeting.summary, action_items: [{ task: 'a', owner: 'Me', due: '' }, { task: 'b', owner: 'Gustavo', due: 'EOD' }] } });
  assert.ok(html.includes('<span class="pill speaker">Me</span>'));
  assert.ok(html.includes('<span class="pill person">Gustavo</span><span class="due">due EOD</span>'));
  assert.ok(!html.includes('class="transcript"'));
});
