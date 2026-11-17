import { test } from 'node:test';
import assert from 'node:assert/strict';
import fmt from '../src/summary-format.js';
import exp from '../src/export-format.js';
import summarize from '../src/summarize.js';

const lesson = {
  kind: 'lesson',
  title: 'Perfekt mit haben und sein',
  overview: 'Review of the Perfekt tense.',
  grammar: [{ rule: 'Perfekt with sein', explanation: 'Verbs of movement use sein.', examples: ['Ich bin nach Wien gefahren.'] }],
  vocabulary: [{ term: 'der Termin, -e', meaning: 'appointment', example: 'Ich habe einen Termin.' }, { term: 'a|b', meaning: 'pipe', example: '' }],
  phrases: [{ phrase: 'Das kommt darauf an.', meaning: 'It depends.' }],
  corrections: [{ said: 'ich habe gefahren', correct: 'ich bin gefahren', note: 'movement → sein' }],
  exercises: ['Pair work in the Perfekt'],
  homework: [{ task: 'Write 100 words about the weekend', due: 'Thursday' }],
  review: ['kennen vs. wissen'],
};
const meeting = { meta: { id: 'x', title: lesson.title, startedAt: '2026-10-22T16:00:00.000Z', endedAt: '2026-10-22T17:30:00.000Z' }, summary: lesson, chunks: [] };

test('lesson kind picks its own schema and prompt; meetings are unchanged', () => {
  assert.equal(fmt.schemaFor('lesson'), fmt.LESSON_SCHEMA);
  assert.equal(fmt.schemaFor('meeting'), fmt.SUMMARY_SCHEMA);
  assert.match(fmt.promptFor('lesson', 'pt'), /Notes language = Portuguese/);
  assert.match(fmt.promptFor('lesson', 'auto'), /teacher mainly explains in/);
  assert.equal(fmt.promptFor('meeting', 'de'), fmt.systemPrompt('de'));
  assert.match(fmt.partPrompt('t', 0, 2, 'lesson'), /part 1 of 2 of one lesson/);
  assert.match(fmt.mergePrompt([{}], 'lesson'), /study notes/);
});

test('German number words become digits before translation', () => {
  const { germanNumbersToDigits: d } = summarize;
  assert.equal(d('Lernt die Seite vierundfünfzig im Buch.'), 'Lernt die Seite 54 im Buch.');
  assert.equal(d('ungefähr hundert Wörter'), 'ungefähr 100 Wörter');
  assert.equal(d('dreiundzwanzig, zwölf, siebzehn, dreihundertzwölf, zweitausendsechsundzwanzig'), '23, 12, 17, 312, 2026');
  assert.equal(d('Ich habe ein Buch und acht Stifte, the elf'), 'Ich habe ein Buch und acht Stifte, the elf');
  assert.equal(d('Hunderte Hundertstel Zehner'), 'Hunderte Hundertstel Zehner');
});

test('only example sentences that were actually said are kept', () => {
  const chunks = [
    { text: 'Neue Wörter für heute: der Termin, die Termine. Ich habe einen Termin beim Arzt.' },
    { text: 'Ich bin nach Wien gefahren. Und die Erfahrung, die Erfahrungen.' },
  ];
  const notes = summarize.keepSaidExamples({
    ...lesson,
    grammar: [{ rule: 'Perfekt mit sein', explanation: '', examples: ['Ich bin nach Wien gefahren.', 'Er ist nach Berlin geflogen.'] }],
    vocabulary: [
      { term: 'der Termin, -e', meaning: '', example: 'Ich habe einen Termin beim Arzt' },
      { term: 'die Erfahrung, -en', meaning: '', example: 'Ich habe eine neue Erfahrung gemacht.' },
    ],
  }, chunks);
  assert.deepEqual(notes.grammar[0].examples, ['Ich bin nach Wien gefahren.']);
  assert.equal(notes.vocabulary[0].example, 'Ich habe einen Termin beim Arzt');
  assert.equal(notes.vocabulary[1].example, '');
});

test('plurals the teacher said override the model', () => {
  const chunks = [{ text: 'Und die Erfahrung, die Erfahrungen. Der Wecker, die Wecker. Der Apfel, die Äpfel.' }];
  const vocab = (term) => ({ term, meaning: '', example: '' });
  const notes = summarize.keepSaidExamples({ ...lesson, grammar: [], vocabulary: [vocab('die Erfahrung, -e'), vocab('der Wecker, -e'), vocab('der Apfel, ¨'), vocab('vereinbaren')] }, chunks);
  assert.deepEqual(notes.vocabulary.map((v) => v.term), ['die Erfahrung, -en', 'der Wecker, -', 'der Apfel, ¨', 'vereinbaren']);
});

test('lesson markdown has grammar, a vocabulary table, corrections and homework', () => {
  const md = fmt.toMarkdown(lesson);
  assert.match(md, /^# Perfekt mit haben und sein\n/);
  assert.ok(md.includes('### Perfekt with sein\n\nVerbs of movement use sein.\n\n- *Ich bin nach Wien gefahren.*'));
  assert.ok(md.includes('| Word | Meaning | Example |\n| --- | --- | --- |\n| der Termin, -e | appointment | Ich habe einen Termin. |'));
  assert.ok(md.includes('| a\\|b | pipe |  |'), 'pipes in cells are escaped');
  assert.ok(md.includes('- ~~ich habe gefahren~~ → **ich bin gefahren** (movement → sein)'));
  assert.ok(md.includes('- [ ] Write 100 words about the weekend (due Thursday)'));
  assert.ok(!md.includes('## Decisions'));
});

test('lesson text and PDF exports use the lesson sections', () => {
  const txt = exp.toPlainText(meeting);
  for (const s of ['GRAMMAR', 'VOCABULARY', '  der Termin, -e: appointment  (Ich habe einen Termin.)', 'CORRECTIONS', '  ich habe gefahren  ->  ich bin gefahren', 'HOMEWORK', 'TO REVIEW']) {
    assert.ok(txt.includes(s), `missing ${JSON.stringify(s)}`);
  }
  const html = exp.toPrintHtml(meeting);
  assert.ok(html.includes('<table class="vocab">'));
  assert.ok(html.includes('<td class="term">der Termin, -e</td>'));
  assert.ok(html.includes('<span class="said">ich habe gefahren</span>'));
  assert.ok(!html.includes('Action items'));
});
