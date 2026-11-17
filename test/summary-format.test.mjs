import { test } from 'node:test';
import assert from 'node:assert/strict';
import fmt from '../src/summary-format.js';

const LABELS = { microphone: 'Me', system: 'Them' };
const c = (source, text, startMs) => ({ source, text, startMs, isFinal: true });

test('transcript joins consecutive turns of the same speaker, in time order', () => {
  const text = fmt.formatTranscript(
    [c('system', 'Sounds good.', 9000), c('microphone', 'Hi all.', 0), c('microphone', 'Quick agenda.', 2000), c('system', '', 9500)],
    LABELS,
  );
  assert.equal(text, '[0:00] Me: Hi all. Quick agenda.\n[0:09] Them: Sounds good.');
});

test('long transcripts split at line boundaries within the limit', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i} ${'x'.repeat(20)}`);
  const parts = fmt.splitTranscript(lines.join('\n'), 60);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 60));
  assert.equal(parts.join('\n'), lines.join('\n'));
});

test('the summary language follows the setting', () => {
  assert.match(fmt.systemPrompt('de'), /in German\.$/);
  assert.match(fmt.systemPrompt('auto'), /mostly spoken/);
});

test('markdown renders sections and skips empty ones', () => {
  const md = fmt.toMarkdown({
    title: 'Weekly sync',
    overview: 'Release planning.',
    topics: [{ topic: 'Timeline', points: ['Release moved to May 3'] }],
    decisions: [],
    action_items: [{ task: 'Send design doc', owner: 'Felipe', due: 'Friday' }, { task: 'Book room', owner: '', due: '' }],
    open_questions: [],
  });
  assert.equal(md, [
    '# Weekly sync',
    '## Overview', 'Release planning.',
    '## Topics', '### Timeline', '- Release moved to May 3',
    '## Action items', '- [ ] Send design doc (Felipe, due Friday)\n- [ ] Book room',
  ].join('\n\n') + '\n');
});
