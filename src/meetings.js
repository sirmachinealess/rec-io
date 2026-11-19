// Meeting storage. Each meeting has raw data in .data/<id>/ and one readable
// document in the meetings folder, named after its topic once summarized:
//   meetings/2026-10-20 21.08 – Release delay and launch pricing.md
//   meetings/.data/<id>/{meta.json, transcript.jsonl, summary.json, speakers.json}
// speakers.json (optional) holds the speaker labels for the system channel; see speakers.js.
const fs = require('node:fs');
const path = require('node:path');
const { toMarkdown } = require('./summary-format');
const speakers = require('./speakers');

const LABELS = { microphone: 'Me', system: 'Them' };
const UNTITLED = 'Untitled recording';
const ID_PATTERN = /^\d{4}-\d{2}-\d{2}T[\d-]+Z$/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

// Model titles sometimes arrive quoted, with a trailing period or a "Meeting:" prefix.
function cleanTitle(title) {
  let t = String(title ?? '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(meeting|summary|besprechung|reunião)\s*[:–-]\s*/i, '');
  t = t.replace(/^["'“”‘’\s]+|["'“”‘’.\s]+$/g, '');
  if (t.length > 70) t = `${t.slice(0, 70).replace(/\s+\S*$/, '')}…`;
  return t || null;
}

// A title made safe for a Windows file name.
function safeFileTitle(title) {
  let t = String(title ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/[. ]+$/, '');
  if (t.length > 80) t = t.slice(0, 80).replace(/\s+\S*$/, '');
  if (!t || RESERVED.test(t)) t = UNTITLED;
  return t;
}

const pad = (n) => String(n).padStart(2, '0');
function fileDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
}

function formatTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatDuration(ms) {
  const min = Math.round(ms / 60000);
  return min < 1 ? 'under a minute' : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

function buildDocument(meta, summary, chunks) {
  const when = new Date(meta.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const subtitle = meta.endedAt ? `${when} · ${formatDuration(new Date(meta.endedAt) - new Date(meta.startedAt))}` : when;
  const head = summary
    ? toMarkdown({ ...summary, title: meta.title || summary.title }, { date: subtitle }).trimEnd()
    : `# ${meta.title || UNTITLED}\n\n_${subtitle}_`;
  const lines = chunks.map((c) => `**${c.speaker ?? LABELS[c.source] ?? c.source}** [${formatTime(c.startMs)}]: ${c.text}`);
  return `${head}\n\n---\n\n## Transcript\n\n${lines.join('\n\n') || '_Nothing was transcribed._'}\n`;
}

class MeetingStore {
  constructor(root) {
    this.root = root;
    this.dataRoot = path.join(root, '.data');
  }

  dir(id) {
    if (!ID_PATTERN.test(id)) throw new Error('invalid meeting id');
    return path.join(this.dataRoot, id);
  }

  readMeta(id) {
    return JSON.parse(fs.readFileSync(path.join(this.dir(id), 'meta.json'), 'utf8'));
  }

  writeMeta(meta) {
    fs.writeFileSync(path.join(this.dir(meta.id), 'meta.json'), JSON.stringify(meta, null, 2));
  }

  // kind: 'meeting' (summary) or 'lesson' (study notes for a class).
  create(id, startedAt, kind = 'meeting') {
    fs.mkdirSync(this.dir(id), { recursive: true });
    const meta = { id, title: null, startedAt, endedAt: null, file: null, kind };
    this.writeMeta(meta);
    return meta;
  }

  appendChunk(id, chunk) {
    fs.appendFileSync(path.join(this.dir(id), 'transcript.jsonl'), JSON.stringify(chunk) + '\n');
  }

  readChunks(id) {
    const file = path.join(this.dir(id), 'transcript.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').flatMap((line) => {
      try {
        return line ? [JSON.parse(line)] : [];
      } catch {
        return [];
      }
    }).sort((a, b) => a.startMs - b.startMs);
  }

  // Chunks with speaker labels applied (system chunks get .speaker / .speakerId
  // when speaker separation ran). Use this for anything people or the model read.
  labeledChunks(id) {
    return speakers.labelChunks(this.readChunks(id), this.readSpeakers(id));
  }

  readSpeakers(id) {
    const file = path.join(this.dir(id), 'speakers.json');
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data?.version === speakers.VERSION ? data : null;
    } catch {
      return null;
    }
  }

  // Written to a temporary file and renamed, so a crash never leaves half a file.
  writeSpeakers(id, data) {
    const file = path.join(this.dir(id), 'speakers.json');
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
    fs.renameSync(`${file}.tmp`, file);
    return this.writeDocument(id);
  }

  // Result of speaker separation: turns on the recording timeline.
  setSpeakerTurns(id, turns) {
    return this.writeSpeakers(id, speakers.createSpeakers(this.readChunks(id), turns));
  }

  updateSpeakers(id, change) {
    const data = this.readSpeakers(id);
    if (!data) throw new Error('This recording has no separated speakers');
    return this.writeSpeakers(id, change(data));
  }

  renameSpeaker(id, speaker, name) {
    return this.updateSpeakers(id, (d) => speakers.renameSpeaker(d, speaker, name));
  }

  mergeSpeaker(id, from, into) {
    return this.updateSpeakers(id, (d) => speakers.mergeSpeaker(d, from, into));
  }

  unmergeSpeaker(id, speaker) {
    return this.updateSpeakers(id, (d) => speakers.unmergeSpeaker(d, speaker));
  }

  readSummary(id) {
    const file = path.join(this.dir(id), 'summary.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  }

  finish(id, endedAt = new Date().toISOString()) {
    const meta = { ...this.readMeta(id), endedAt };
    this.writeMeta(meta);
    return this.writeDocument(id);
  }

  setSummary(id, summary) {
    fs.writeFileSync(path.join(this.dir(id), 'summary.json'), JSON.stringify(summary, null, 2));
    const meta = { ...this.readMeta(id), title: cleanTitle(summary.title), kind: summary.kind ?? 'meeting' };
    this.writeMeta(meta);
    return this.writeDocument(id);
  }

  // (Re)writes the readable document under a name built from date + topic,
  // removing the previous file when the name changed.
  writeDocument(id) {
    const meta = this.readMeta(id);
    const base = `${fileDate(meta.startedAt)} – ${safeFileTitle(meta.title || UNTITLED)}`;
    let name = `${base}.md`;
    for (let n = 2; fs.existsSync(path.join(this.root, name)) && name !== meta.file; n++) name = `${base} (${n}).md`;
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(path.join(this.root, name), buildDocument(meta, this.readSummary(id), this.labeledChunks(id)));
    if (meta.file && meta.file !== name) fs.rmSync(path.join(this.root, meta.file), { force: true });
    const updated = { ...meta, file: name };
    this.writeMeta(updated);
    return updated;
  }

  list() {
    if (!fs.existsSync(this.dataRoot)) return [];
    return fs.readdirSync(this.dataRoot)
      .filter((id) => ID_PATTERN.test(id) && fs.existsSync(path.join(this.dataRoot, id, 'meta.json')))
      .map((id) => ({ ...this.readMeta(id), hasSummary: fs.existsSync(path.join(this.dataRoot, id, 'summary.json')) }))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id) {
    const summary = this.readSummary(id);
    const meta = this.readMeta(id);
    const chunks = this.readChunks(id);
    const speakerData = this.readSpeakers(id);
    return {
      meta,
      chunks: speakers.labelChunks(chunks, speakerData),
      speakers: speakers.speakerList(chunks, speakerData),
      summary,
      summaryMarkdown: summary ? toMarkdown({ ...summary, title: meta.title || summary.title }) : '',
    };
  }

  documentPath(id) {
    const { file } = this.readMeta(id);
    return file ? path.join(this.root, file) : null;
  }

  // Moves files from the earlier flat layout (<id>.jsonl, <id>.md, <id>.summary.*)
  // into .data/<id>/ and writes the new topic-named document. Nothing is deleted.
  migrateFlat() {
    if (!fs.existsSync(this.root)) return 0;
    let migrated = 0;
    for (const file of fs.readdirSync(this.root)) {
      const m = /^(.+)\.jsonl$/.exec(file);
      if (!m || !ID_PATTERN.test(m[1]) || fs.existsSync(this.dir(m[1]))) continue;
      const id = m[1];
      const startedAt = id.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
      this.create(id, startedAt);
      const chunks = this.readFlatChunks(path.join(this.root, file));
      const last = chunks.reduce((max, c) => Math.max(max, c.endMs ?? c.startMs), 0);
      fs.renameSync(path.join(this.root, file), path.join(this.dir(id), 'transcript.jsonl'));
      for (const [from, to] of [[`${id}.summary.json`, 'summary.json'], [`${id}.md`, 'legacy-transcript.md'], [`${id}.summary.md`, 'legacy-summary.md']]) {
        if (fs.existsSync(path.join(this.root, from))) fs.renameSync(path.join(this.root, from), path.join(this.dir(id), to));
      }
      const summary = this.readSummary(id);
      this.writeMeta({ ...this.readMeta(id), endedAt: new Date(new Date(startedAt).getTime() + last).toISOString(), title: summary ? cleanTitle(summary.title) : null });
      this.writeDocument(id);
      migrated++;
    }
    return migrated;
  }

  readFlatChunks(file) {
    return fs.readFileSync(file, 'utf8').split('\n').flatMap((l) => {
      try {
        return l ? [JSON.parse(l)] : [];
      } catch {
        return [];
      }
    });
  }
}

module.exports = { MeetingStore, cleanTitle, safeFileTitle, formatTime, formatDuration, LABELS, UNTITLED };
