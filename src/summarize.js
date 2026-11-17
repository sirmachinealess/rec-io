// Turns a transcript into a structured summary (or lesson notes) with a local
// model. Recordings that don't fit the context window are summarized in parts,
// then merged.
const { CONTEXT_TOKENS } = require('./llama-server');
const fmt = require('./summary-format');

// ~3 characters per token for mixed-language speech; leave room for the
// instructions and a long JSON answer (lesson notes carry longer lists).
const ANSWER_TOKENS = { meeting: 3000, lesson: 4000 };
const MERGE_TOKENS = { meeting: 4000, lesson: 5000 };
const partChars = (kind) => Math.floor((CONTEXT_TOKENS - ANSWER_TOKENS[kind] - 1000) * 3);
const MAX_PART_CHARS = partChars('meeting');

// The model tends to write long fields in the transcript's language even when
// asked otherwise, so lesson notes get a second, narrow pass: only the
// notes-language fields are sent, translated, and put back by position. Words
// in the taught language (terms, examples, corrections) are never sent.
const strArray = (n) => ({ type: 'array', items: { type: 'string' }, minItems: n, maxItems: n });
const TRANSLATION_EXAMPLE_IN = { homework: ['Lernt die Seite ⟦#54⟧ im Buch.'], meanings: ['Verabredung', 'to arrange'], review: ['Unterschied zwischen \'⟦0⟧\' und \'⟦1⟧\''] };
const TRANSLATION_EXAMPLE = {
  English: { in: TRANSLATION_EXAMPLE_IN, out: { homework: ['Study page ⟦#54⟧ of the book.'], meanings: ['appointment', 'to arrange'], review: ['Difference between \'⟦0⟧\' and \'⟦1⟧\''] } },
  Portuguese: { in: TRANSLATION_EXAMPLE_IN, out: { homework: ['Estudar a página ⟦#54⟧ do livro.'], meanings: ['compromisso', 'combinar, marcar'], review: ['Diferença entre \'⟦0⟧\' e \'⟦1⟧\''] } },
  German: { in: TRANSLATION_EXAMPLE_IN, out: { homework: ['Lernt die Seite ⟦#54⟧ im Buch.'], meanings: ['Verabredung', 'vereinbaren, festlegen'], review: ['Unterschied zwischen \'⟦0⟧\' und \'⟦1⟧\''] } },
};
// Words of the taught language (from the title, rule names and vocabulary) are
// swapped for markers before translating, so "haben" never becomes "have".
const SHORT_WORDS = new Set(['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'mit', 'und', 'oder', 'von', 'zu', 'im', 'in', 'am', 'an', 'auf', 'für']);
function protectedWords(notes) {
  const words = new Set();
  const add = (text) => {
    for (const w of String(text ?? '').split(/[^\p{L}-]+/u)) if (w.length >= 3 && !SHORT_WORDS.has(w.toLowerCase())) words.add(w);
  };
  add(notes.title);
  for (const g of notes.grammar) add(g.rule);
  for (const v of notes.vocabulary) add(v.term.split(',')[0]);
  return [...words].sort((a, b) => b.length - a.length);
}
// German number words become digits before translation (plain code, not the
// model), e.g. "vierundfünfzig" -> 54, so they can be masked and never change.
const DE_UNITS = { ein: 1, eins: 1, zwei: 2, drei: 3, vier: 4, 'fünf': 5, sechs: 6, sieben: 7, acht: 8, neun: 9 };
const DE_TEENS = { zehn: 10, elf: 11, 'zwölf': 12, dreizehn: 13, vierzehn: 14, 'fünfzehn': 15, sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19 };
const DE_TENS = { zwanzig: 20, 'dreißig': 30, dreissig: 30, vierzig: 40, 'fünfzig': 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90 };
function deBelow100(s) {
  if (s in DE_UNITS) return DE_UNITS[s];
  if (s in DE_TEENS) return DE_TEENS[s];
  if (s in DE_TENS) return DE_TENS[s];
  const m = /^(.+?)und(.+)$/.exec(s);
  return m && m[1] in DE_UNITS && m[2] in DE_TENS ? DE_UNITS[m[1]] + DE_TENS[m[2]] : null;
}
function deBelow1000(s) {
  const i = s.indexOf('hundert');
  if (i < 0) return deBelow100(s);
  const left = s.slice(0, i), rest = s.slice(i + 7);
  const h = left === '' ? 1 : DE_UNITS[left];
  const r = rest === '' ? 0 : deBelow100(rest);
  return h === undefined || r === null ? null : h * 100 + r;
}
function germanNumber(word) {
  const s = word.toLowerCase();
  const i = s.indexOf('tausend');
  if (i < 0) return deBelow1000(s);
  const t = s.slice(0, i) === '' ? 1 : deBelow1000(s.slice(0, i));
  const r = s.slice(i + 7) === '' ? 0 : deBelow1000(s.slice(i + 7));
  return t === null || r === null ? null : t * 1000 + r;
}
// Only numbers from 10 up: "ein", "eins", "acht" etc. are too often other words,
// and "elf" is also an English word.
const germanNumbersToDigits = (text) => String(text ?? '').replace(/\p{L}+/gu, (w) => {
  const n = w.toLowerCase() === 'elf' ? null : germanNumber(w);
  return n !== null && n >= 10 ? String(n) : w;
});

// Numbers are protected the same way, so a page or a date can never change value.
function maskWords(text, words) {
  let out = String(text ?? '').replace(/\d+/g, (n) => `⟦#${n}⟧`);
  words.forEach((w, i) => {
    out = out.replace(new RegExp(`(?<![\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'gu'), `⟦${i}⟧`);
  });
  return out;
}
const unmaskWords = (text, words) => String(text ?? '')
  .replace(/⟦#(\d+)⟧/g, (m, n) => n)
  .replace(/⟦(\d+)⟧/g, (m, i) => words.at(Number(i)) ?? m);

async function translateLessonNotes(notes, language, llm) {
  const lang = fmt.LANGUAGES[language];
  if (!lang) return notes;
  const words = protectedWords(notes);
  const prep = (x) => maskWords(germanNumbersToDigits(x), words);
  const mask = (v) => (Array.isArray(v) ? v.map(prep) : prep(v));
  const raw = {
    overview: notes.overview,
    explanations: notes.grammar.map((g) => g.explanation),
    meanings: notes.vocabulary.map((v) => v.meaning),
    phrase_meanings: notes.phrases.map((p) => p.meaning),
    correction_notes: notes.corrections.map((c) => c.note),
    exercises: notes.exercises,
    homework: notes.homework.map((h) => h.task),
    homework_due: notes.homework.map((h) => h.due),
    review: notes.review,
  };
  const src = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, mask(v)]));
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(src),
    properties: Object.fromEntries(Object.entries(src).map(([k, v]) => [k, Array.isArray(v) ? strArray(v.length) : { type: 'string' }])),
  };
  const example = TRANSLATION_EXAMPLE[lang];
  const system = [
    `You translate study notes into ${lang}. EVERY value in the output must be written in ${lang}.`,
    `Translate every sentence completely into ${lang}, including German or English sentences.`,
    'Only a single word or short expression that is being learned, written in quotes, stays as it is (for example \'sein\', \'der Termin\').',
    'Keep the same keys, the same number of items and the same order. Empty strings stay empty.',
    'Numbers keep exactly the same value, written as digits (vierundfünfzig = 54).',
    'Markers like ⟦0⟧ or ⟦#54⟧ stand for words and numbers that must not be translated: copy every marker exactly, in a fitting place.',
    '',
    `Example. Input: ${JSON.stringify(example.in)}`,
    `Output: ${JSON.stringify(example.out)}`,
  ].join('\n');
  const t = await llm.chatJson([{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(src) }], schema, { maxTokens: ANSWER_TOKENS.lesson, temperature: 0 });
  for (const k of Object.keys(t)) t[k] = Array.isArray(t[k]) ? t[k].map((x) => unmaskWords(x, words)) : unmaskWords(t[k], words);
  return {
    ...notes,
    overview: t.overview,
    grammar: notes.grammar.map((g, i) => ({ ...g, explanation: t.explanations.at(i) ?? g.explanation })),
    vocabulary: notes.vocabulary.map((v, i) => ({ ...v, meaning: t.meanings.at(i) ?? v.meaning })),
    phrases: notes.phrases.map((p, i) => ({ ...p, meaning: t.phrase_meanings.at(i) ?? p.meaning })),
    corrections: notes.corrections.map((c, i) => ({ ...c, note: t.correction_notes.at(i) ?? c.note })),
    exercises: notes.exercises.map((e, i) => t.exercises.at(i) ?? e),
    homework: notes.homework.map((h, i) => ({ ...h, task: t.homework.at(i) ?? h.task, due: t.homework_due.at(i) ?? h.due })),
    review: notes.review.map((r, i) => t.review.at(i) ?? r),
  };
}

// The model invents plausible example sentences even when told not to. For a
// learner a made-up (and possibly wrong) sentence is worse than none, so every
// example is checked against the transcript: it stays only if at least 80% of
// its words occur, in order of appearance, within one stretch of what was said.
const words = (s) => String(s ?? '').toLowerCase().normalize('NFC').match(/\p{L}+|\d+/gu) ?? [];
function wasSaid(example, spokenWords) {
  const ex = words(example);
  if (ex.length === 0) return false;
  let best = 0;
  for (let start = 0; start < spokenWords.length; start++) {
    if (spokenWords[start] !== ex[0] && spokenWords[start] !== ex[1]) continue;
    let hit = 0;
    let j = start;
    for (const w of ex) {
      const k = spokenWords.indexOf(w, j);
      if (k !== -1 && k - j <= 3) {
        hit++;
        j = k + 1;
      }
    }
    best = Math.max(best, hit / ex.length);
  }
  return best >= 0.8;
}
// A plural the teacher actually said ("die Erfahrungen", "die Wecker") wins over
// the model's guess: "die Erfahrung, -e" becomes "die Erfahrung, -en". Plurals
// with an umlaut change (der Apfel, die Äpfel) are left as the model wrote them.
function pluralFromTranscript(term, text) {
  const m = /^(der|die|das)\s+([\p{L}-]+)/u.exec(term.trim());
  if (!m) return term;
  const [, article, singular] = m;
  // "die <word>": for a feminine noun the singular itself matches, so take the
  // first form that differs; for der/das an identical form is a real plural.
  const forms = [...text.matchAll(new RegExp(`(?<![\\p{L}])die\\s+(${singular}\\p{L}*)(?![\\p{L}])`, 'gu'))].map((x) => x[1]);
  const plural = forms.find((f) => f !== singular) ?? (article !== 'die' ? forms.find((f) => f === singular) : undefined);
  if (plural === undefined) return term;
  return `${article} ${singular}, -${plural.slice(singular.length)}`;
}

function keepSaidExamples(notes, chunks) {
  const text = chunks.map((c) => c.text).join(' ');
  const spoken = words(text);
  return {
    ...notes,
    grammar: notes.grammar.map((g) => ({ ...g, examples: g.examples.filter((e) => wasSaid(e, spoken)) })),
    vocabulary: notes.vocabulary.map((v) => ({ ...v, term: pluralFromTranscript(v.term, text), example: wasSaid(v.example, spoken) ? v.example : '' })),
  };
}

async function summarizeTranscript(options) {
  let summary = await draftSummary(options);
  if (summary.kind !== 'lesson') return summary;
  summary = keepSaidExamples(summary, options.chunks);
  if (!fmt.LANGUAGES[options.language]) return summary;
  options.onProgress?.('Translating the notes…');
  return translateLessonNotes(summary, options.language, options.llm);
}

async function draftSummary({ chunks, labels, language, kind = 'meeting', llm, onProgress = () => {} }) {
  if (!fmt.KINDS.includes(kind)) throw new Error(`unknown summary type: ${kind}`);
  const transcript = fmt.formatTranscript(chunks, labels);
  if (!transcript.trim()) throw new Error('Nothing was transcribed, so there is nothing to summarize.');
  const system = { role: 'system', content: fmt.promptFor(kind, language) };
  const schema = fmt.schemaFor(kind);
  const parts = fmt.splitTranscript(transcript, partChars(kind));

  const partSummaries = [];
  for (const [i, part] of parts.entries()) {
    onProgress(parts.length > 1 ? `Reading part ${i + 1} of ${parts.length}…` : kind === 'lesson' ? 'Writing study notes…' : 'Writing summary…');
    partSummaries.push(await llm.chatJson([system, { role: 'user', content: fmt.partPrompt(part, i, parts.length, kind) }], schema, { maxTokens: ANSWER_TOKENS[kind] }));
  }
  if (partSummaries.length === 1) return { ...partSummaries[0], kind };

  onProgress('Merging parts…');
  const merged = await llm.chatJson([system, { role: 'user', content: fmt.mergePrompt(partSummaries, kind) }], schema, { maxTokens: MERGE_TOKENS[kind] });
  return { ...merged, kind };
}

module.exports = { summarizeTranscript, germanNumbersToDigits, keepSaidExamples, MAX_PART_CHARS };
