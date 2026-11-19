// Pure helpers for summaries: the JSON schemas (meeting summary, lesson notes),
// transcript formatting, splitting long recordings, the prompts, and Markdown output.

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'overview', 'topics', 'decisions', 'action_items', 'open_questions'],
  properties: {
    title: { type: 'string' },
    overview: { type: 'string' },
    topics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['topic', 'points'],
        properties: {
          topic: { type: 'string' },
          points: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    decisions: { type: 'array', items: { type: 'string' } },
    action_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['task', 'owner', 'due'],
        properties: {
          task: { type: 'string' },
          owner: { type: 'string' },
          due: { type: 'string' },
        },
      },
    },
    open_questions: { type: 'array', items: { type: 'string' } },
  },
};

// Study notes for a recorded language lesson (summary kind "lesson").
const LESSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'overview', 'grammar', 'vocabulary', 'phrases', 'corrections', 'exercises', 'homework', 'review'],
  properties: {
    title: { type: 'string' },
    overview: { type: 'string' },
    grammar: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rule', 'explanation', 'examples'],
        properties: {
          rule: { type: 'string' },
          explanation: { type: 'string' },
          examples: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    vocabulary: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['term', 'meaning', 'example'],
        properties: {
          term: { type: 'string' },
          meaning: { type: 'string' },
          example: { type: 'string' },
        },
      },
    },
    phrases: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['phrase', 'meaning'],
        properties: { phrase: { type: 'string' }, meaning: { type: 'string' } },
      },
    },
    corrections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['said', 'correct', 'note'],
        properties: { said: { type: 'string' }, correct: { type: 'string' }, note: { type: 'string' } },
      },
    },
    exercises: { type: 'array', items: { type: 'string' } },
    homework: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['task', 'due'],
        properties: { task: { type: 'string' }, due: { type: 'string' } },
      },
    },
    review: { type: 'array', items: { type: 'string' } },
  },
};

const KINDS = ['meeting', 'lesson'];
const LANGUAGES = { en: 'English', de: 'German', pt: 'Portuguese' };

function formatTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// One line per speaker turn: consecutive chunks with the same label are joined.
// A chunk's own .speaker (from speaker separation) wins over labels[source], so
// a change of speaker starts a new turn even within the system channel.
function formatTranscript(chunks, labels) {
  const lines = [];
  let last = null;
  for (const c of [...chunks].filter((c) => c.text).sort((a, b) => a.startMs - b.startMs)) {
    const who = c.speaker ?? labels[c.source] ?? c.source;
    if (last && last.who === who) {
      last.text += ` ${c.text}`;
    } else {
      last = { who, startMs: c.startMs, text: c.text };
      lines.push(last);
    }
  }
  return lines.map((l) => `[${formatTime(l.startMs)}] ${l.who}: ${l.text}`).join('\n');
}

// Splits at line boundaries into parts of at most maxChars (a longer line stands alone).
function splitTranscript(text, maxChars) {
  const parts = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current && current.length + 1 + line.length > maxChars) {
      parts.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function systemPrompt(language) {
  const lang = LANGUAGES[language] ?? 'the language that was mostly spoken in the meeting';
  return [
    'You write accurate, structured summaries of meetings from transcripts.',
    'The transcript comes from automatic speech recognition. "Me" is the person who recorded it;',
    '"Them" is everyone heard through the computer audio (one or more people).',
    'It may contain recognition errors: read past obvious mistakes, but never invent facts.',
    'title: the main topic of the whole meeting in 3 to 8 words, specific enough to recognize it later',
    '(for example "Release delay and launch pricing"); no words like "meeting", "summary" or a date.',
    'Cover everything substantive that was said, grouped into topics in the order discussed.',
    'Keep names, numbers, dates, amounts and commitments exactly.',
    'decisions: only things actually agreed. action_items: concrete tasks; owner is "Me", "Them"',
    'or a person named in the transcript, and owner/due are "" when not stated.',
    'Use empty arrays when a section does not apply.',
    `Write every field in ${lang}.`,
  ].join(' ');
}

// A small local model follows a concrete example far better than abstract rules,
// so the prompt shows one filled entry per field in the notes language.
const LESSON_EXAMPLE = {
  English: { meaning: 'appointment', explanation: 'Verbs of movement form the Perfekt with "sein".', note: '"fahren" is a movement, so it takes "sein".', task: 'Write about 100 words about the weekend in the Perfekt.', review: 'Difference between "kennen" and "wissen".' },
  Portuguese: { meaning: 'compromisso, consulta', explanation: 'Verbos de movimento formam o Perfekt com "sein".', note: '"fahren" é um movimento, por isso usa "sein".', task: 'Escrever cerca de 100 palavras sobre o fim de semana no Perfekt.', review: 'Diferença entre "kennen" e "wissen".' },
  German: { meaning: 'Verabredung zu einer festen Zeit', explanation: 'Verben der Bewegung bilden das Perfekt mit "sein".', note: '"fahren" ist eine Bewegung, also mit "sein".', task: 'Etwa 100 Wörter über das Wochenende im Perfekt schreiben.', review: 'Unterschied zwischen "kennen" und "wissen".' },
};

function lessonSystemPrompt(language) {
  const lang = LANGUAGES[language];
  const ex = LESSON_EXAMPLE[lang] ?? LESSON_EXAMPLE.German;
  const notesLang = lang ?? 'the language the teacher mainly explains in';
  return [
    'You turn a recorded language lesson into clear, well-organized study notes for the student.',
    'The transcript comes from automatic speech recognition. "Me" is the student who recorded it;',
    '"Them" is the teacher and the other students heard through the computer audio.',
    'Learners and accents cause recognition errors: fix obvious misspellings of words in the language',
    'being taught, but never add content that was not in the lesson.',
    '',
    `TWO LANGUAGES. Notes language = ${notesLang}. Taught language = the language being learned.`,
    `Write in the notes language (${notesLang}): overview, grammar.explanation, vocabulary.meaning,`,
    'phrases.meaning, corrections.note, exercises, homework.task, review.',
    'Write in the taught language, exactly as said and correctly spelled: title, grammar.rule,',
    'grammar.examples, vocabulary.term, vocabulary.example, phrases.phrase, corrections.said, corrections.correct.',
    '',
    'title: the lesson\'s main topic in 3 to 8 words (e.g. "Perfekt mit haben und sein"); no "lesson", "class" or date.',
    'grammar.rule: a SHORT name of 2 to 6 words (e.g. "Perfekt mit sein"), not a sentence.',
    'grammar.examples: example sentences from the lesson; [] if none.',
    'vocabulary: ONE entry per word. Nouns as "article singular, plural ending":',
    'the teacher saying "der Termin, die Termine" gives ONE entry with term "der Termin, -e";',
    'a plural identical to the singular ("der Wecker, die Wecker") is written "der Wecker, -".',
    'Verbs in the infinitive.',
    'vocabulary.example: copy a sentence that was actually said in the transcript and contains the word;',
    'if there is none, use "". NEVER write a new example sentence yourself.',
    'corrections: only mistakes the teacher actually corrected.',
    'Numbers (pages, exercises, dates, amounts) exactly as said, written as digits: "Seite vierundfünfzig" = page 54.',
    'exercises: what was practiced in class (not the homework). homework.due: "" if not stated.',
    'review: questions the student asked, unclear points, things announced for later.',
    'Use [] when a section does not apply.',
    '',
    `Example entries in the right languages: {"term":"der Termin, -e","meaning":"${ex.meaning}"}`,
    `{"rule":"Perfekt mit sein","explanation":"${ex.explanation}","examples":["Ich bin nach Wien gefahren."]}`,
    `{"said":"Ich habe nach Salzburg gefahren.","correct":"Ich bin nach Salzburg gefahren.","note":"${ex.note}"}`,
    `{"task":"${ex.task}","due":"Donnerstag"} · review: "${ex.review}"`,
  ].join('\n');
}

function promptFor(kind, language) {
  return kind === 'lesson' ? lessonSystemPrompt(language) : systemPrompt(language);
}

function schemaFor(kind) {
  return kind === 'lesson' ? LESSON_SCHEMA : SUMMARY_SCHEMA;
}

function partPrompt(transcript, index, total, kind = 'meeting') {
  const what = kind === 'lesson' ? 'lesson' : 'meeting';
  const scope = total > 1 ? `This is part ${index + 1} of ${total} of one ${what}. Summarize only this part.\n\n` : '';
  return `${scope}Transcript:\n${transcript}`;
}

function mergePrompt(partSummaries, kind = 'meeting') {
  const how = kind === 'lesson'
    ? ['These JSON objects are study notes for consecutive parts of one language lesson.',
      'Merge them into one set of notes for the whole lesson: one title and overview; grammar,',
      'vocabulary, phrases and corrections merged without duplicates (keep every distinct item);',
      'every exercise, homework task and review point kept.']
    : ['These JSON objects summarize consecutive parts of one meeting.',
      'Merge them into a single summary of the whole meeting: one title and overview,',
      'topics merged and deduplicated in order, and every decision, action item and open question kept.'];
  return [...how, '', JSON.stringify(partSummaries)].join('\n');
}

function lessonMarkdown(s, date) {
  const out = [`# ${s.title || 'Lesson notes'}`];
  if (date) out.push(`_${date}_`);
  if (s.overview) out.push('## Overview', s.overview);
  if (s.grammar?.length) {
    out.push('## Grammar');
    for (const g of s.grammar) {
      out.push(`### ${g.rule}`, [g.explanation, ...g.examples.map((e) => `- *${e}*`)].filter(Boolean).join('\n\n'));
    }
  }
  if (s.vocabulary?.length) {
    const cell = (t) => String(t ?? '').replace(/\|/g, '\\|');
    const rows = s.vocabulary.map((v) => `| ${cell(v.term)} | ${cell(v.meaning)} | ${cell(v.example)} |`);
    out.push('## Vocabulary', ['| Word | Meaning | Example |', '| --- | --- | --- |', ...rows].join('\n'));
  }
  if (s.phrases?.length) out.push('## Useful phrases', s.phrases.map((p) => `- **${p.phrase}**: ${p.meaning}`).join('\n'));
  if (s.corrections?.length) {
    out.push('## Corrections', s.corrections.map((c) => `- ~~${c.said}~~ → **${c.correct}**${c.note ? ` (${c.note})` : ''}`).join('\n'));
  }
  if (s.exercises?.length) out.push('## Exercises practiced', s.exercises.map((e) => `- ${e}`).join('\n'));
  if (s.homework?.length) out.push('## Homework', s.homework.map((h) => `- [ ] ${h.task}${h.due ? ` (due ${h.due})` : ''}`).join('\n'));
  if (s.review?.length) out.push('## To review', s.review.map((r) => `- ${r}`).join('\n'));
  return `${out.join('\n\n')}\n`;
}

function toMarkdown(summary, { date } = {}) {
  if (summary.kind === 'lesson') return lessonMarkdown(summary, date);
  const out = [`# ${summary.title || 'Meeting summary'}`];
  if (date) out.push(`_${date}_`);
  if (summary.overview) out.push('## Overview', summary.overview);
  if (summary.topics?.length) {
    out.push('## Topics');
    for (const t of summary.topics) out.push(`### ${t.topic}`, t.points.map((p) => `- ${p}`).join('\n'));
  }
  if (summary.decisions?.length) out.push('## Decisions', summary.decisions.map((d) => `- ${d}`).join('\n'));
  if (summary.action_items?.length) {
    const items = summary.action_items.map((a) => {
      const meta = [a.owner, a.due && `due ${a.due}`].filter(Boolean).join(', ');
      return `- [ ] ${a.task}${meta ? ` (${meta})` : ''}`;
    });
    out.push('## Action items', items.join('\n'));
  }
  if (summary.open_questions?.length) out.push('## Open questions', summary.open_questions.map((q) => `- ${q}`).join('\n'));
  return `${out.join('\n\n')}\n`;
}

module.exports = {
  SUMMARY_SCHEMA, LESSON_SCHEMA, KINDS, LANGUAGES, formatTranscript, splitTranscript, systemPrompt, lessonSystemPrompt,
  promptFor, schemaFor, partPrompt, mergePrompt, toMarkdown,
};
