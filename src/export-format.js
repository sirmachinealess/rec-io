// Export renderers for one meeting: plain text (.txt) and a print page that
// Electron turns into a PDF. Styling matches the app: Inter, #FF7518 orange, #347EAF blue.
const { formatTime, formatDuration, LABELS, UNTITLED } = require('./meetings');

const SPEAKER_TAGS = new Set(['me', 'them', 'ich', 'eu', 'eles', 'sie']);

function describe(meta) {
  const when = new Date(meta.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return meta.endedAt ? `${when} · ${formatDuration(new Date(meta.endedAt) - new Date(meta.startedAt))}` : when;
}

// ---------- plain text ----------

function toPlainText({ meta, summary, chunks }, { includeTranscript = false } = {}) {
  const title = meta.title || summary?.title || UNTITLED;
  const out = [title, '='.repeat(Math.min(title.length, 72)), describe(meta), ''];
  const section = (name, lines) => {
    if (lines.length) out.push(name.toUpperCase(), ...lines, '');
  };

  if (summary?.kind === 'lesson') {
    const s = summary;
    section('Lesson overview', s.overview ? [s.overview] : []);
    section('Grammar', s.grammar.flatMap((g) => [g.rule, `  ${g.explanation}`, ...g.examples.map((e) => `    > ${e}`), '']).slice(0, -1));
    section('Vocabulary', s.vocabulary.map((v) => `  ${v.term}: ${v.meaning}${v.example ? `  (${v.example})` : ''}`));
    section('Useful phrases', s.phrases.map((p) => `  ${p.phrase}: ${p.meaning}`));
    section('Corrections', s.corrections.map((c) => `  ${c.said}  ->  ${c.correct}${c.note ? `  (${c.note})` : ''}`));
    section('Exercises practiced', s.exercises.map((e) => `  - ${e}`));
    section('Homework', s.homework.map((h) => `  [ ] ${h.task}${h.due ? ` (due ${h.due})` : ''}`));
    section('To review', s.review.map((r) => `  - ${r}`));
  } else if (summary) {
    section('Summary', summary.overview ? [summary.overview] : []);
    section('Topics', summary.topics.flatMap((t) => [t.topic, ...t.points.map((p) => `  - ${p}`), '']).slice(0, -1));
    section('Decisions', summary.decisions.map((d) => `  - ${d}`));
    section('Action items', summary.action_items.map((a) => {
      const meta = [a.owner, a.due && `due ${a.due}`].filter(Boolean).join(', ');
      return `  [ ] ${a.task}${meta ? ` (${meta})` : ''}`;
    }));
    section('Open questions', summary.open_questions.map((q) => `  - ${q}`));
  } else {
    out.push('No summary yet.', '');
  }
  if (includeTranscript) {
    section('Transcript', chunks.length
      ? chunks.map((c) => `[${formatTime(c.startMs)}] ${LABELS[c.source] ?? c.source}: ${c.text}`)
      : ['Nothing was transcribed.']);
  }
  out.push(`Exported from rec.io on ${new Date().toLocaleString()}`);
  return `${out.join('\r\n')}\r\n`;
}

// ---------- print page (PDF) ----------

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function ownerPill(owner) {
  const kind = SPEAKER_TAGS.has(owner.trim().toLowerCase()) ? 'speaker' : 'person';
  return `<span class="pill ${kind}">${escapeHtml(owner)}</span>`;
}

function summaryHtml(s) {
  const parts = [];
  if (s.overview) parts.push(`<section><div class="label">Meeting summary</div><p class="overview">${escapeHtml(s.overview)}</p></section>`);
  if (s.topics.length) {
    parts.push(`<section><div class="label">Topics</div><div class="topics">${s.topics.map((t) =>
      `<div class="topic"><h3>${escapeHtml(t.topic)}</h3><ul>${t.points.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul></div>`).join('')}</div></section>`);
  }
  if (s.action_items.length) {
    parts.push(`<section><div class="label">Action items</div><div class="tasks">${s.action_items.map((a) =>
      `<div class="task"><span class="box"></span><span class="what">${escapeHtml(a.task)}</span>${a.owner ? ownerPill(a.owner) : ''}${a.due ? `<span class="due">due ${escapeHtml(a.due)}</span>` : ''}</div>`).join('')}</div></section>`);
  }
  if (s.decisions.length) parts.push(`<section><div class="label">Decisions</div><ul class="plain">${s.decisions.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul></section>`);
  if (s.open_questions.length) parts.push(`<section><div class="label">Open questions</div><ul class="plain">${s.open_questions.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ul></section>`);
  return parts.join('');
}

function lessonHtml(s) {
  const list = (items) => `<ul class="plain">${items.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`;
  const parts = [];
  if (s.overview) parts.push(`<section><div class="label">Lesson overview</div><p class="overview">${escapeHtml(s.overview)}</p></section>`);
  if (s.grammar.length) {
    parts.push(`<section><div class="label">Grammar</div><div class="topics">${s.grammar.map((g) =>
      `<div class="topic"><h3>${escapeHtml(g.rule)}</h3><p class="expl">${escapeHtml(g.explanation)}</p>${g.examples.length ? `<ul>${g.examples.map((e) => `<li class="ex">${escapeHtml(e)}</li>`).join('')}</ul>` : ''}</div>`).join('')}</div></section>`);
  }
  if (s.vocabulary.length) {
    parts.push(`<section><div class="label">Vocabulary</div><table class="vocab"><thead><tr><th>Word</th><th>Meaning</th><th>Example</th></tr></thead><tbody>${s.vocabulary.map((v) =>
      `<tr><td class="term">${escapeHtml(v.term)}</td><td>${escapeHtml(v.meaning)}</td><td class="ex">${escapeHtml(v.example)}</td></tr>`).join('')}</tbody></table></section>`);
  }
  if (s.phrases.length) {
    parts.push(`<section><div class="label">Useful phrases</div><div class="tasks">${s.phrases.map((p) =>
      `<div class="task"><span class="what"><b>${escapeHtml(p.phrase)}</b></span><span class="muted">${escapeHtml(p.meaning)}</span></div>`).join('')}</div></section>`);
  }
  if (s.corrections.length) {
    parts.push(`<section><div class="label">Corrections</div><div class="tasks">${s.corrections.map((c) =>
      `<div class="task corr"><span class="said">${escapeHtml(c.said)}</span><span class="arrow">→</span><span class="what"><b>${escapeHtml(c.correct)}</b>${c.note ? `<br><span class="muted">${escapeHtml(c.note)}</span>` : ''}</span></div>`).join('')}</div></section>`);
  }
  if (s.homework.length) {
    parts.push(`<section><div class="label">Homework</div><div class="tasks">${s.homework.map((h) =>
      `<div class="task"><span class="box"></span><span class="what">${escapeHtml(h.task)}</span>${h.due ? `<span class="due">due ${escapeHtml(h.due)}</span>` : ''}</div>`).join('')}</div></section>`);
  }
  if (s.exercises.length) parts.push(`<section><div class="label">Exercises practiced</div>${list(s.exercises)}</section>`);
  if (s.review.length) parts.push(`<section><div class="label">To review</div>${list(s.review)}</section>`);
  return parts.join('');
}

function transcriptHtml(chunks) {
  if (!chunks.length) return '<section class="transcript"><div class="label">Transcript</div><p class="muted">Nothing was transcribed.</p></section>';
  return `<section class="transcript"><div class="label">Transcript</div>${chunks.map((c) =>
    `<div class="line ${escapeHtml(c.source)}"><span class="who">${escapeHtml(LABELS[c.source] ?? c.source)} <span class="t">${formatTime(c.startMs)}</span></span><span class="text">${escapeHtml(c.text)}</span></div>`).join('')}</section>`;
}

// fontBase: a file:// URL of the folder holding the bundled .woff2 files.
function toPrintHtml({ meta, summary, chunks }, { includeTranscript = false, fontBase = '' } = {}) {
  const title = meta.title || summary?.title || UNTITLED;
  const body = summary ? (summary.kind === 'lesson' ? lessonHtml(summary) : summaryHtml(summary)) : '<p class="muted">No summary yet.</p>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
@font-face { font-family: Inter; font-weight: 100 900; src: url("${fontBase}/inter-latin-wght-normal.woff2") format("woff2"); unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD; }
@font-face { font-family: Inter; font-weight: 100 900; src: url("${fontBase}/inter-latin-ext-wght-normal.woff2") format("woff2"); unicode-range: U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF; }
* { box-sizing: border-box; }
body { margin: 0; font: 400 10.5pt/1.6 Inter, "Segoe UI", sans-serif; color: #334155; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.brand { display: flex; align-items: center; justify-content: space-between; padding-bottom: 12px; border-bottom: 1px solid #E5E7EB; }
.brand .logo { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 13pt; letter-spacing: -0.02em; color: #0F172A; }
.brand .tile { width: 24px; height: 24px; border-radius: 7px; background: #FF7518; display: grid; place-items: center; }
.brand .io { color: #FF7518; }
.brand .when { font-size: 8.5pt; color: #64748B; }
h1 { font-size: 20pt; line-height: 1.25; font-weight: 700; letter-spacing: -0.02em; color: #0F172A; margin: 20px 0 8px; }
.badges { display: flex; gap: 6px; margin-bottom: 18px; }
.badge { padding: 2px 10px; border-radius: 999px; font-size: 8.5pt; font-weight: 500; background: #F9FAFB; border: 1px solid #E5E7EB; color: #64748B; }
.badge.blue { background: rgba(52,126,175,0.1); border-color: transparent; color: #2A6690; }
section { margin-top: 16px; }
.label { font-size: 7.5pt; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #64748B; margin-bottom: 8px; }
.overview { margin: 0; font-size: 11pt; line-height: 1.7; color: #0F172A; padding: 14px 16px; border: 1px solid #E5E7EB; border-radius: 12px; }
.topics { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.topic { padding: 12px 14px 12px 16px; border-radius: 12px; border: 1px solid #E5E7EB; border-left: 3px solid #347EAF; background: rgba(52,126,175,0.05); break-inside: avoid; }
.topic h3 { margin: 0 0 4px; font-size: 10.5pt; font-weight: 650; color: #0F172A; }
.topic ul, ul.plain { margin: 0; padding-left: 16px; }
.topic li { font-size: 9.5pt; }
li { margin: 2px 0; }
li::marker { color: #347EAF; }
.tasks { border: 1px solid #E5E7EB; border-radius: 12px; padding: 0 14px; }
.task { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-top: 1px solid #E5E7EB; break-inside: avoid; }
.task:first-child { border-top: 0; }
.box { width: 12px; height: 12px; border: 1.5px solid #D1D5DB; border-radius: 4px; flex: none; }
.what { flex: 1; font-size: 10pt; color: #0F172A; }
.pill { padding: 2px 9px; border-radius: 999px; font-size: 8pt; font-weight: 600; white-space: nowrap; }
.pill.speaker { background: rgba(255,117,24,0.12); color: #C2540A; }
.pill.person { background: rgba(52,126,175,0.1); color: #2A6690; }
.due { padding: 2px 9px; border-radius: 999px; font-size: 8pt; color: #64748B; border: 1px solid #E5E7EB; white-space: nowrap; }
.transcript { margin-top: 24px; border-top: 1px solid #E5E7EB; padding-top: 14px; }
.line { display: grid; grid-template-columns: 70px 1fr; gap: 10px; padding: 4px 0; break-inside: avoid; font-size: 9.5pt; color: #0F172A; }
.who { font-weight: 600; color: #C2540A; }
.line.microphone .who { color: #2A6690; }
.who .t { font-weight: 400; font-size: 8pt; color: #94A3B8; font-variant-numeric: tabular-nums; }
.muted { color: #64748B; }
.expl { margin: 0 0 6px; font-size: 9.5pt; }
.ex { font-style: italic; color: #0F172A; }
table.vocab { width: 100%; border-collapse: collapse; font-size: 9.5pt; border: 1px solid #E5E7EB; border-radius: 12px; }
table.vocab th { text-align: left; font-size: 7.5pt; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #64748B; padding: 7px 10px; border-bottom: 1px solid #E5E7EB; }
table.vocab td { padding: 6px 10px; border-top: 1px solid #F1F5F9; vertical-align: top; }
table.vocab tr { break-inside: avoid; }
td.term { font-weight: 600; color: #0F172A; white-space: nowrap; }
.corr .said { text-decoration: line-through; color: #94A3B8; }
.corr .arrow { color: #FF7518; font-weight: 700; }
</style></head><body>
<div class="brand"><div class="logo"><span class="tile"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2.6" stroke-linecap="round"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/></svg></span><span>rec<span class="io">.io</span></span></div><div class="when">Meeting notes</div></div>
<h1>${escapeHtml(title)}</h1>
<div class="badges"><span class="badge">${escapeHtml(describe(meta))}</span><span class="badge blue">${includeTranscript ? 'Summary + transcript' : 'Summary'}</span></div>
${body}
${includeTranscript ? transcriptHtml(chunks) : ''}
</body></html>`;
}

module.exports = { toPlainText, toPrintHtml, escapeHtml };
