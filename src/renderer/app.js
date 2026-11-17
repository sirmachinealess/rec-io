import { getMicrophone, getSystemAudio, startPcmCapture } from './capture.js';
import { LocalAsrStream } from './local-asr.js';
import { TranscriptStore, formatTime } from './transcript.js';

const $ = (id) => document.getElementById(id);
const LABELS = { microphone: 'Me', system: 'Them' };
const UNTITLED = 'Untitled recording';
const SPEAKER_TAGS = new Set(['me', 'them', 'ich', 'eu', 'eles', 'sie']);
const WAVE_BARS = 28;

// ---------- small DOM helpers ----------
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}
function icon(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = path; // static, trusted markup only
  return svg;
}
const ICONS = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.8-4M4 4v4h4M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
  pdf: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M8.5 13h1.5a1.5 1.5 0 0 1 0 3H8.5v-3Zm0 3v2M14 13v5M14 13h2.5M14 15.5h2"/>',
  txt: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M9 13h6M9 16h6M9 10h2"/>',
  export: '<path d="M12 15V3m0 0L8 7m4-4 4 4M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  wave: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  speaker: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
  download: '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/>',
};

// ---------- settings (remembered on this PC) ----------
const SETTINGS_KEY = 'recio.settings';
const settingFields = { recordingKind: 'recording-kind', useSystem: 'use-system', language: 'language', vocabulary: 'vocabulary', autoSummary: 'auto-summary', summaryLanguage: 'summary-language' };
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    for (const [key, id] of Object.entries(settingFields)) {
      if (!(key in saved)) continue;
      const el = $(id);
      if (el.type === 'checkbox') el.checked = Boolean(saved[key]);
      else el.value = saved[key];
    }
  } catch {
    // Storage unavailable: keep the defaults in the markup.
  }
}
function saveSettings() {
  const values = Object.fromEntries(Object.entries(settingFields).map(([key, id]) => [key, $(id).type === 'checkbox' ? $(id).checked : $(id).value]));
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(values));
  } catch {
    // Not persisted; settings still apply for this session.
  }
}

// Theme lives in the main process (it also colors the window frame).
function showTheme(theme) {
  for (const b of document.querySelectorAll('.seg [data-theme]')) b.setAttribute('aria-pressed', String(b.dataset.theme === theme));
}

// ---------- state ----------
const state = {
  meetings: [],
  selectedId: null,
  engineReady: false,
  summary: { installed: false, downloadGb: '3.2', setupProgress: null },
  summarizing: null, // { id, label }
  summaryErrors: {}, // id -> message
  recording: null, // { id, startedAt, stops, store, timer, sourceStates, levels }
};

// ---------- formatting ----------
function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}
const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
function duration(meta) {
  if (!meta.endedAt) return null;
  const min = Math.round((new Date(meta.endedAt) - new Date(meta.startedAt)) / 60000);
  return min < 1 ? '< 1 min' : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}
const cleanError = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ---------- toast ----------
let toastTimer;
function toast(message, actions = []) {
  const el = $('toast');
  clearTimeout(toastTimer);
  el.replaceChildren(h('span', { class: 'msg', title: message }, message), ...actions.map(([label, fn]) => h('button', { onclick: fn }, label)));
  el.hidden = false;
  toastTimer = setTimeout(() => (el.hidden = true), 7000);
}

// ---------- sidebar ----------
function renderSidebar() {
  const list = $('meeting-list');
  const items = [...state.meetings];
  if (state.recording && !items.some((m) => m.id === state.recording.id)) {
    items.unshift({ id: state.recording.id, startedAt: state.recording.startedAt, title: null });
  }
  if (items.length === 0) {
    list.replaceChildren(h('p', { class: 'empty-list' }, 'Your recordings will appear here.'));
    return;
  }
  const nodes = [];
  let lastDay = null;
  for (const m of items) {
    const day = dayLabel(m.startedAt);
    if (day !== lastDay) nodes.push(h('div', { class: 'group-label' }, day));
    lastDay = day;
    const live = state.recording?.id === m.id;
    const busy = state.summarizing?.id === m.id;
    nodes.push(
      h('button', { class: `meeting-item${m.id === state.selectedId ? ' active' : ''}`, onclick: () => selectMeeting(m.id) },
        h('span', { class: `t${m.title ? '' : ' untitled'}` }, m.title || (live ? 'New recording' : UNTITLED)),
        h('span', { class: 's' },
          h('span', {}, clock(m.startedAt)),
          live ? h('span', { class: 'live-tag' }, '· recording') : busy ? h('span', { class: 'live-tag' }, '· summarizing') : duration(m) && h('span', {}, `· ${duration(m)}`),
          m.kind === 'lesson' && h('span', { class: 'kind-tag' }, 'Class'))),
    );
  }
  list.replaceChildren(...nodes);
}

async function refreshMeetings() {
  state.meetings = await window.recio.listMeetings();
  renderSidebar();
}

// ---------- shared pieces ----------
function lineNode(c) {
  return h('div', { class: `line ${c.source}${c.isFinal === false ? ' partial' : ''}` },
    h('span', { class: 'who' }, LABELS[c.source], h('span', { class: 't' }, formatTime(c.startMs))), c.text);
}
const sectionLabel = (text) => h('div', { class: 'section-label' }, text);
const badge = (iconPath, text, cls = '') => h('span', { class: `badge ${cls}` }, iconPath && icon(iconPath), text);
function ownerPill(owner) {
  return h('span', { class: `pill ${SPEAKER_TAGS.has(owner.trim().toLowerCase()) ? 'speaker' : 'person'}` }, owner);
}
function iconButton(iconPath, tip, onclick, disabled) {
  return h('button', { class: 'icon-btn', 'aria-label': tip, 'data-tip': tip, onclick, disabled: disabled || undefined }, icon(iconPath));
}

// ---------- hero ----------
function renderHero() {
  $('content').replaceChildren(
    h('div', { class: 'hero' },
      h('div', { class: 'mark' }, icon(ICONS.wave)),
      h('h1', {}, 'Ready when you are'),
      h('p', {}, 'Record a call or a conversation. rec.io transcribes it on this PC and writes a summary named after what you talked about.'),
      h('button', { class: 'btn btn-primary', onclick: startRecording, disabled: !state.engineReady || undefined }, h('span', { class: 'dot' }), 'Start recording'),
    ),
  );
}

// ---------- live recording ----------
function sourceCard(source) {
  const isMe = source === 'microphone';
  const on = isMe || $('use-system').checked;
  return h('div', { class: 'card span-3' },
    h('div', { class: `source ${isMe ? 'me' : 'them'}` },
      h('span', { class: 'ico' }, icon(isMe ? ICONS.mic : ICONS.speaker)),
      h('div', { class: 'name' }, LABELS[source]),
      h('div', { class: 'meter', id: `meter-${source}`, 'aria-hidden': 'true' }, Array.from({ length: 10 }, () => h('i'))),
      h('span', { class: 'state', id: `state-${source}` }, on ? 'starting' : 'off')));
}

function renderLive() {
  const rec = state.recording;
  const content = $('content');
  if (!$('live-doc')) {
    content.replaceChildren(
      h('article', { class: 'doc', id: 'live-doc' },
        h('div', { class: 'doc-head' },
          h('div', { class: 'titles' },
            h('h1', { class: 'untitled' }, rec.kind === 'lesson' ? 'New class' : 'New recording'),
            h('div', { class: 'meta' }, h('span', { class: 'badge live' }, h('i'), 'Recording'), badge(ICONS.clock, `Started ${clock(rec.startedAt)}`)))),
        h('div', { class: 'bento' },
          sourceCard('microphone'), sourceCard('system'),
          h('div', { class: 'card span-6' }, sectionLabel('Live transcript'), h('div', { id: 'live-lines' })))),
    );
    for (const [source, text] of Object.entries(rec.sourceStates ?? {})) setSourceState(source, text);
  }
  const finals = rec.store.chunks;
  $('live-lines').replaceChildren(finals.length
    ? h('div', { class: 'lines' }, finals.map(lineNode))
    : h('div', { class: 'listening' }, 'Listening… text appears a moment after each sentence.'));
  content.scrollTop = content.scrollHeight;
}

function setSourceState(source, text) {
  if (state.recording) (state.recording.sourceStates ??= {})[source] = text;
  const el = $(`state-${source}`);
  if (el) el.textContent = text;
}

// Level of a 100 ms Int16 frame, 0..1 (-60 dBFS .. -12 dBFS).
function frameLevel(frame) {
  const pcm = new Int16Array(frame);
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  const db = 20 * Math.log10(Math.sqrt(sum / Math.max(1, pcm.length)) / 32768 + 1e-9);
  return Math.max(0, Math.min(1, (db + 60) / 48));
}

function showLevel(source, level) {
  if (state.recording) state.recording.levels[source] = Math.max(state.recording.levels[source] ?? 0, level);
  const meter = $(`meter-${source}`);
  if (!meter) return;
  [...meter.children].forEach((bar, i) => {
    const on = level > i / meter.children.length;
    bar.classList.toggle('on', on);
    bar.style.height = on ? `${6 + Math.min(1, (level - i / 10) * 10) * 12}px` : '4px';
  });
}

// ---------- control-bar waveform ----------
const IDLE_WAVE = Array.from({ length: WAVE_BARS }, (_, i) => 0.18 + 0.22 * Math.abs(Math.sin(i * 0.55)) * Math.abs(Math.cos(i * 0.21)));
let waveHistory = [...IDLE_WAVE];
function drawWave() {
  const bars = $('dock-wave').children;
  waveHistory.forEach((v, i) => (bars[i].style.height = `${3 + v * 19}px`));
}
function tickWave() {
  const rec = state.recording;
  if (!rec) return;
  const level = Math.max(rec.levels.microphone ?? 0, rec.levels.system ?? 0);
  rec.levels.microphone = (rec.levels.microphone ?? 0) * 0.5;
  rec.levels.system = (rec.levels.system ?? 0) * 0.5;
  waveHistory = [...waveHistory.slice(1), level];
  drawWave();
}

// ---------- summary ----------
function summaryPlaceholder(meeting) {
  const { id } = meeting.meta;
  if (state.summarizing?.id === id) {
    return h('div', { class: 'placeholder' },
      h('div', { class: 'row' }, h('span', { class: 'spinner' }), state.summarizing.label || 'Writing summary…'),
      h('div', { class: 'shimmer' }, h('i', { style: 'width: 92%' }), h('i', { style: 'width: 78%' }), h('i', { style: 'width: 85%' })));
  }
  if (!state.summary.installed) {
    const p = state.summary.setupProgress;
    return h('div', { class: 'placeholder' },
      h('p', {}, `Summaries run on this PC after a one-time ${state.summary.downloadGb} GB download (llama.cpp and the Qwen3 4B model).`),
      p
        ? h('div', { style: 'width: 100%; display: grid; gap: 6px' }, h('div', { class: 'bar' }, h('i', { style: `width: ${p.pct}%` })), h('small', {}, `${p.label} · ${p.pct}%`))
        : h('button', { class: 'btn btn-outline', onclick: setupSummaries }, icon(ICONS.download), 'Set up summaries'));
  }
  if (meeting.chunks.length === 0) return h('div', { class: 'placeholder' }, h('p', {}, 'Nothing was transcribed in this recording, so there is nothing to summarize.'));
  return h('div', { class: 'placeholder' },
    h('p', {}, state.summaryErrors[id] ? `The summary failed: ${state.summaryErrors[id]}` : 'No summary yet.'),
    h('button', { class: 'btn btn-outline', onclick: () => runSummary(id), disabled: Boolean(state.summarizing) || undefined }, 'Summarize'));
}

function summaryCards(meeting) {
  const { meta, summary: s } = meeting;
  const busy = state.summarizing?.id === meta.id;
  const tools = s && !busy && h('div', { class: 'tools' },
    iconButton(ICONS.refresh, 'Re-summarize', () => runSummary(meta.id), Boolean(state.summarizing)),
    iconButton(ICONS.copy, 'Copy as Markdown', async (e) => {
      const btn = e.currentTarget;
      await navigator.clipboard.writeText(meeting.summaryMarkdown);
      btn.replaceChildren(icon(ICONS.check));
      btn.classList.add('done');
      btn.dataset.tip = 'Copied';
      setTimeout(() => {
        btn.replaceChildren(icon(ICONS.copy));
        btn.classList.remove('done');
        btn.dataset.tip = 'Copy as Markdown';
      }, 1500);
    }));

  const kind = s?.kind ?? meta.kind ?? 'meeting';
  // Switching the type re-writes the summary in the other format.
  const kindSelect = h('select', {
    class: 'kind-select',
    'aria-label': 'Summary type',
    disabled: Boolean(state.summarizing) || !state.summary.installed || meeting.chunks.length === 0 || undefined,
    onchange: (e) => runSummary(meta.id, e.currentTarget.value),
  },
  h('option', { value: 'meeting', selected: kind === 'meeting' || undefined }, 'Meeting summary'),
  h('option', { value: 'lesson', selected: kind === 'lesson' || undefined }, 'Class study notes'));

  const cards = [
    h('section', { class: 'card summary-card span-6' },
      h('div', { class: 'card-top' }, sectionLabel(kind === 'lesson' ? 'Lesson notes' : 'Summary'), kindSelect, tools),
      s && !busy ? h('p', { class: 'overview' }, s.overview || 'No overview.') : summaryPlaceholder(meeting)),
  ];
  if (!s || busy) return cards;
  if (s.kind === 'lesson') return [...cards, ...lessonCards(s)];

  if (s.topics.length) {
    cards.push(h('section', { class: 'section span-6' }, sectionLabel('Topics'),
      h('div', { class: 'topics' }, s.topics.map((t) => h('div', { class: 'topic' }, h('h3', {}, t.topic), h('ul', {}, t.points.map((p) => h('li', {}, p))))))));
  }
  if (s.action_items.length) {
    cards.push(h('section', { class: 'card span-6' }, h('div', { class: 'card-top' }, sectionLabel('Action items')),
      s.action_items.map((a) => h('div', { class: 'task' },
        h('span', { class: 'box', 'aria-hidden': 'true' }),
        h('span', { class: 'what' }, a.task),
        (a.owner || a.due) && h('span', { class: 'tags' }, a.owner && ownerPill(a.owner), a.due && h('span', { class: 'pill due' }, a.due))))));
  }
  const lists = [['Decisions', s.decisions], ['Open questions', s.open_questions]].filter(([, items]) => items.length);
  for (const [title, items] of lists) {
    cards.push(h('section', { class: `card ${lists.length === 2 ? 'span-3' : 'span-6'}` }, h('div', { class: 'card-top' }, sectionLabel(title)),
      h('ul', { class: 'plain-list' }, items.map((x) => h('li', {}, x)))));
  }
  return cards;
}

// Study notes for a language class.
function lessonCards(s) {
  const cards = [];
  const half = (a, b) => (a.length && b.length ? 'span-3' : 'span-6');
  if (s.grammar.length) {
    cards.push(h('section', { class: 'section span-6' }, sectionLabel('Grammar'),
      h('div', { class: 'topics' }, s.grammar.map((g) => h('div', { class: 'topic' },
        h('h3', {}, g.rule),
        h('p', { class: 'expl' }, g.explanation),
        g.examples.length > 0 && h('ul', {}, g.examples.map((e) => h('li', { class: 'ex', lang: 'de' }, e))))))));
  }
  if (s.vocabulary.length) {
    cards.push(h('section', { class: 'card span-6' }, h('div', { class: 'card-top' }, sectionLabel(`Vocabulary · ${s.vocabulary.length}`)),
      h('table', { class: 'vocab' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Word'), h('th', {}, 'Meaning'), h('th', {}, 'Example'))),
        h('tbody', {}, s.vocabulary.map((v) => h('tr', {}, h('td', { class: 'term', lang: 'de' }, v.term), h('td', {}, v.meaning), h('td', { class: 'ex', lang: 'de' }, v.example)))))));
  }
  if (s.phrases.length) {
    cards.push(h('section', { class: `card ${half(s.phrases, s.corrections)}` }, h('div', { class: 'card-top' }, sectionLabel('Useful phrases')),
      s.phrases.map((p) => h('div', { class: 'task phrase' }, h('span', { class: 'what' }, h('strong', { lang: 'de' }, p.phrase), h('span', { class: 'mean' }, p.meaning))))));
  }
  if (s.corrections.length) {
    cards.push(h('section', { class: `card ${half(s.phrases, s.corrections)}` }, h('div', { class: 'card-top' }, sectionLabel('Corrections')),
      s.corrections.map((c) => h('div', { class: 'task corr' },
        h('span', { class: 'what' },
          h('span', { class: 'said', lang: 'de' }, c.said),
          h('span', { class: 'right', lang: 'de' }, c.correct),
          c.note && h('span', { class: 'mean' }, c.note))))));
  }
  if (s.homework.length) {
    cards.push(h('section', { class: 'card span-6' }, h('div', { class: 'card-top' }, sectionLabel('Homework')),
      s.homework.map((hw) => h('div', { class: 'task' },
        h('span', { class: 'box', 'aria-hidden': 'true' }),
        h('span', { class: 'what' }, hw.task),
        hw.due && h('span', { class: 'tags' }, h('span', { class: 'pill speaker' }, `due ${hw.due}`))))));
  }
  for (const [title, items] of [['Exercises practiced', s.exercises], ['To review', s.review]]) {
    if (items.length) {
      cards.push(h('section', { class: `card ${half(s.exercises, s.review)}` }, h('div', { class: 'card-top' }, sectionLabel(title)),
        h('ul', { class: 'plain-list' }, items.map((x) => h('li', {}, x)))));
    }
  }
  return cards;
}

// ---------- export menu ----------
function closeMenus() {
  for (const m of document.querySelectorAll('.menu')) m.remove();
  for (const b of document.querySelectorAll('[aria-haspopup="menu"]')) b.setAttribute('aria-expanded', 'false');
}

function openExportMenu(button, meeting) {
  const wasOpen = button.getAttribute('aria-expanded') === 'true';
  closeMenus();
  if (wasOpen) return;
  const has = Boolean(meeting.summary);
  const item = (format, includeTranscript, title, sub) =>
    h('button', { role: 'menuitem', onclick: () => { closeMenus(); exportMeeting(meeting.meta.id, format, includeTranscript); } },
      icon(format === 'pdf' ? ICONS.pdf : ICONS.txt), h('span', { class: 'm-title' }, title), h('span', { class: 'm-sub' }, sub));
  const menu = h('div', { class: 'popover menu', role: 'menu' },
    has && item('pdf', false, 'PDF · summary', 'Formatted A4 page, ready to print or share'),
    item('pdf', true, has ? 'PDF · summary + transcript' : 'PDF · transcript', 'Full record, with every line and timestamp'),
    h('hr'),
    has && item('txt', false, 'Text file · summary', 'Plain .txt for email, notes or any editor'),
    item('txt', true, has ? 'Text file · summary + transcript' : 'Text file · transcript', 'Plain .txt with every line'));
  button.after(menu);
  button.setAttribute('aria-expanded', 'true');
  menu.querySelector('button')?.focus();
}

async function exportMeeting(id, format, includeTranscript) {
  toast(format === 'pdf' ? 'Preparing PDF…' : 'Saving text file…');
  try {
    const file = await window.recio.exportMeeting(id, { format, includeTranscript });
    if (!file) {
      $('toast').hidden = true;
      return;
    }
    const name = file.split(/[\\/]/).pop();
    toast(`Saved ${name}`, [['Open', () => window.recio.openExport(file)], ['Show in folder', () => window.recio.revealExport(file)]]);
  } catch (err) {
    toast(`Export failed: ${cleanError(err)}`);
  }
}

// ---------- meeting document ----------
async function renderMeeting(id) {
  const meeting = await window.recio.getMeeting(id);
  if (state.selectedId !== id || state.recording?.id === id) return;
  const { meta, chunks } = meeting;

  const fileInfo = meta.file && h('button', {
    class: 'icon-btn tip-left',
    'aria-label': `File: ${meta.file}. Click to show it in Explorer.`,
    'data-tip': meta.file,
    onclick: () => window.recio.revealMeeting(id),
  }, icon(ICONS.info));

  const head = h('div', { class: 'doc-head' },
    h('div', { class: 'titles' },
      h('h1', { class: meta.title ? null : 'untitled' }, meta.title || UNTITLED),
      h('div', { class: 'meta' },
        badge(ICONS.calendar, new Date(meta.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })),
        duration(meta) && badge(ICONS.clock, duration(meta)),
        meta.file && badge(ICONS.doc, 'Markdown', 'blue'),
        fileInfo)),
    h('div', { class: 'doc-actions' },
      h('button', { class: 'btn btn-outline', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: (e) => openExportMenu(e.currentTarget, meeting) },
        icon(ICONS.export), 'Export', icon(ICONS.chevronDown))));

  $('content').replaceChildren(
    h('article', { class: 'doc' }, head,
      h('div', { class: 'bento' },
        summaryCards(meeting),
        h('section', { class: 'card span-6' },
          h('details', { class: 'transcript', open: !meeting.summary || undefined },
            h('summary', {}, icon(ICONS.chevron), sectionLabel(`Transcript · ${chunks.length} ${chunks.length === 1 ? 'line' : 'lines'}`)),
            h('div', { class: 'lines' }, chunks.map(lineNode)))))),
  );
  // Start at the top when a different recording, or a newly written summary, is shown
  // (the live view before it is scrolled to the bottom).
  const view = `${id}:${Boolean(meeting.summary)}:${state.summarizing?.id === id}`;
  if (view !== lastMeetingView) $('content').scrollTop = 0;
  lastMeetingView = view;
}
let lastMeetingView = null;

function renderContent() {
  if (state.recording && state.selectedId === state.recording.id) return renderLive();
  if (state.selectedId) return renderMeeting(state.selectedId);
  return renderHero();
}

function selectMeeting(id) {
  state.selectedId = id;
  renderSidebar();
  renderContent();
}

// ---------- engine + dock ----------
function setEngineStatus(status) {
  state.engineReady = status.startsWith('ready');
  const pill = $('engine-pill');
  pill.className = `badge engine ${state.engineReady ? 'blue ready' : status.startsWith('error') ? 'error' : 'loading'}`;
  $('engine-text').textContent = state.engineReady ? `Engine ready · ${status.includes('GPU') ? 'GPU' : 'CPU'}` : status.charAt(0).toUpperCase() + status.slice(1);
  pill.title = `Transcription engine: ${status}`;
  updateDock();
  if (!state.selectedId) renderHero();
}

function updateDock() {
  const btn = $('record');
  const rec = state.recording;
  btn.className = `btn ${rec ? 'btn-solid' : 'btn-primary'}`;
  btn.firstElementChild.className = rec ? 'sq' : 'dot';
  btn.lastElementChild.textContent = rec ? (rec.stopping ? 'Stopping…' : 'Stop') : 'Start recording';
  btn.disabled = rec ? Boolean(rec.stopping) : !state.engineReady;
  $('dock').classList.toggle('live', Boolean(rec));
  $('dock-hint').hidden = Boolean(rec);
  $('dock-hint').textContent = state.engineReady ? 'Ready' : 'Loading…';
  $('rec-live').hidden = !rec;
  $('new-recording').disabled = Boolean(rec) || !state.engineReady;
}

// ---------- recording ----------
async function startSource(rec, source, getStream) {
  const stream = await getStream();
  const asr = new LocalAsrStream({
    source,
    offsetMs: Date.now() - new Date(rec.startedAt).getTime(),
    getOptions: () => ({ language: $('language').value, prompt: $('vocabulary').value.trim() }),
    onStatus: (text) => setSourceState(source, text),
    onChunk: (chunk) => {
      rec.store.upsert(chunk);
      if (state.selectedId === rec.id) renderLive();
      if (chunk.isFinal && chunk.text) window.recio.appendChunk(rec.id, chunk).catch((e) => console.error(e.message));
    },
  });
  const stopCapture = await startPcmCapture(stream, (frame) => {
    showLevel(source, frameLevel(frame));
    asr.push(frame);
  });
  return async () => {
    await stopCapture();
    await asr.stop();
  };
}

async function startRecording() {
  if (state.recording || !state.engineReady) return;
  closeMenus();
  const startedAt = new Date().toISOString();
  const id = startedAt.replace(/[:.]/g, '-');
  const kind = $('recording-kind').value;
  await window.recio.createMeeting(id, startedAt, kind);
  const rec = { id, startedAt, kind, stops: [], store: new TranscriptStore(), sourceStates: {}, levels: {} };
  state.recording = rec;
  state.selectedId = id;
  $('rec-timer').textContent = '0:00';
  rec.timer = setInterval(() => ($('rec-timer').textContent = formatTime(Date.now() - new Date(startedAt).getTime())), 1000);
  rec.waveTimer = setInterval(tickWave, 90);
  updateDock();
  renderSidebar();
  renderLive();

  const sources = [['microphone', getMicrophone]];
  if ($('use-system').checked) sources.push(['system', getSystemAudio]);
  for (const [source, getStream] of sources) {
    try {
      rec.stops.push(await startSource(rec, source, getStream));
    } catch (err) {
      console.error(`[${source}] failed to start: ${err.message}`);
      setSourceState(source, 'unavailable');
    }
  }
  if (rec.stops.length === 0) await stopRecording();
}

async function stopRecording() {
  const rec = state.recording;
  if (!rec || rec.stopping) return;
  rec.stopping = true;
  updateDock();
  await Promise.all(rec.stops.map((stop) => stop()));
  clearInterval(rec.timer);
  clearInterval(rec.waveTimer);
  waveHistory = [...IDLE_WAVE];
  drawWave();
  await window.recio.finishMeeting(rec.id);
  state.recording = null;
  updateDock();
  await refreshMeetings();
  renderContent();
  if (state.summary.installed && $('auto-summary').checked && rec.store.chunks.some((c) => c.isFinal && c.text)) runSummary(rec.id);
}

// ---------- summaries ----------
// kind: 'meeting' | 'lesson'; omitted = keep the recording's current type.
async function runSummary(id, kind) {
  if (state.summarizing) return;
  state.summarizing = { id, label: 'Starting…' };
  delete state.summaryErrors[id];
  renderSidebar();
  if (state.selectedId === id) renderContent();
  try {
    await window.recio.summarize(id, $('summary-language').value, kind);
  } catch (err) {
    state.summaryErrors[id] = cleanError(err);
  } finally {
    state.summarizing = null;
    await refreshMeetings();
    if (state.selectedId === id) renderContent();
  }
}

async function refreshSummaryStatus() {
  const status = await window.recio.getSummaryStatus();
  state.summary.installed = status.installed;
  state.summary.downloadGb = status.downloadGb;
  $('summary-setup-note').textContent = status.installed
    ? 'The summary model runs on this PC and is unloaded after each summary.'
    : `Not set up yet: a one-time ${status.downloadGb} GB download, started from any recording.`;
}

async function setupSummaries() {
  state.summary.setupProgress = { pct: 0, label: 'Starting download' };
  renderContent();
  try {
    await window.recio.installSummaries();
  } catch (err) {
    toast(`Setup failed: ${cleanError(err)}. Finished files are kept; try again to resume.`);
  } finally {
    state.summary.setupProgress = null;
    await refreshSummaryStatus();
    renderContent();
  }
}

// ---------- wiring ----------
$('dock-wave').replaceChildren(...Array.from({ length: WAVE_BARS }, () => h('i')));
drawWave();
$('record').addEventListener('click', () => (state.recording ? stopRecording() : startRecording()));
$('new-recording').addEventListener('click', startRecording);
$('open-folder').addEventListener('click', () => window.recio.openMeetingsFolder());
// Settings dialog: closes with the X, Escape or a click on the dimmed backdrop;
// Tab stays inside while it is open; focus returns to the Settings button.
const settingsOpen = () => !$('settings-backdrop').hidden;
function openSettings() {
  closeMenus();
  $('settings-backdrop').hidden = false;
  $('settings-toggle').setAttribute('aria-expanded', 'true');
  $('settings').focus();
}
function closeSettings() {
  if (!settingsOpen()) return;
  $('settings-backdrop').hidden = true;
  $('settings-toggle').setAttribute('aria-expanded', 'false');
  $('settings-toggle').focus();
}
const KIND_HINTS = {
  meeting: 'Summary with an overview, topics, decisions, action items and open questions.',
  lesson: 'Study notes with grammar, vocabulary, corrections, homework and points to review.',
};
const showKindHint = () => ($('kind-hint').textContent = KIND_HINTS[$('recording-kind').value] ?? '');

$('settings-toggle').addEventListener('click', () => (settingsOpen() ? closeSettings() : openSettings()));
$('settings-close').addEventListener('click', closeSettings);
$('settings-backdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeSettings();
});
$('recording-kind').addEventListener('change', showKindHint);
for (const b of document.querySelectorAll('.seg [data-theme]')) {
  b.addEventListener('click', async () => {
    showTheme(b.dataset.theme);
    await window.recio.setTheme(b.dataset.theme);
  });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu, [aria-haspopup="menu"]')) closeMenus();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMenus();
    closeSettings();
    return;
  }
  if (e.key === 'Tab' && settingsOpen()) {
    const focusable = [...$('settings').querySelectorAll('button, select, input')].filter((el) => !el.disabled);
    const first = focusable.at(0);
    const last = focusable.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});
for (const id of Object.values(settingFields)) $(id).addEventListener('change', saveSettings);

window.recio.onAsrStatus(setEngineStatus);
window.recio.onSummaryProgress(({ id, label }) => {
  if (state.summarizing?.id !== id) return;
  state.summarizing.label = label.charAt(0).toUpperCase() + label.slice(1);
  if (state.selectedId === id) renderContent();
});
window.recio.onSummarySetupProgress((p) => {
  state.summary.setupProgress = p;
  if (state.selectedId && !state.recording) renderContent();
});

loadSettings();
showKindHint();
showTheme(await window.recio.getTheme());
await Promise.all([refreshMeetings(), refreshSummaryStatus()]);
setEngineStatus(await window.recio.getAsrStatus());
if (state.meetings.length) selectMeeting(state.meetings[0].id);
