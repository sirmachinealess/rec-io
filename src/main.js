const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, nativeTheme, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { toPlainText, toPrintHtml } = require('./export-format');
const { renderPdf } = require('./pdf-export');
const { WhisperServer } = require('./whisper-server');
const { LlamaServer } = require('./llama-server');
const { SummaryPack } = require('./summary-pack');
const { summarizeTranscript } = require('./summarize');
const { MeetingStore, LABELS } = require('./meetings');

// Installed: the engine ships in <install dir>/resources/local. Dev: ./local.
const LOCAL_DIR = app.isPackaged ? path.join(process.resourcesPath, 'local') : path.join(__dirname, '..', 'local');
const MODEL = process.env.WHISPER_MODEL || 'ggml-large-v3-turbo-q5_0.bin';

// Data lives in %APPDATA%\rec.io in both dev and installed mode.
app.setPath('userData', path.join(app.getPath('appData'), 'rec.io'));
const meetingsDir = path.join(app.getPath('userData'), 'meetings');
const meetings = new MeetingStore(meetingsDir);
const summaryPack = new SummaryPack(path.join(app.getPath('userData'), 'llm'));

// Moves recordings saved as flat <id>.jsonl files by early versions into the
// per-meeting layout. Logged to %APPDATA%\rec.io\migration-log.txt.
function migrateOldMeetings() {
  const moved = meetings.migrateFlat();
  if (moved) {
    fs.appendFileSync(path.join(app.getPath('userData'), 'migration-log.txt'), `${new Date().toISOString()} moved ${moved} recordings to the topic-named layout\n`);
  }
}

// ---------- preferences (theme) ----------
const prefsFile = path.join(app.getPath('userData'), 'prefs.json');
function readPrefs() {
  try {
    return JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
  } catch {
    return {};
  }
}
const THEMES = ['system', 'light', 'dark'];
// themeSource drives prefers-color-scheme in the page and the window frame.
nativeTheme.themeSource = THEMES.includes(readPrefs().theme) ? readPrefs().theme : 'system';
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#0A1628' : '#F8FAFC');

// A second launch focuses the open window instead of starting another engine.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

let win = null;
let asrStatus = 'starting…';
const send = (channel, payload) => win?.webContents.send(channel, payload);
const whisper = new WhisperServer({
  localDir: LOCAL_DIR,
  modelName: MODEL,
  onStatus: (status) => {
    asrStatus = status;
    send('asr:status', status);
  },
});

// Offline lock: the page may load only its own files and talk only to localhost.
// (The one-time summary download runs in this process, not in the page.)
function lockNetwork() {
  const allowed = /^(file|devtools|data|blob):|^(https?|wss?):\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const cancel = !allowed.test(details.url);
    if (cancel) console.warn(`[offline-lock] blocked ${details.url}`);
    callback({ cancel });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 720,
    minHeight: 520,
    title: 'rec.io',
    autoHideMenuBar: true,
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false, // Chromium would otherwise download dictionaries
    },
  });

  // System audio on Windows: answer getDisplayMedia() with the whole screen plus
  // WASAPI loopback audio. The renderer drops the video track immediately.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const [screen] = await desktopCapturer.getSources({ types: ['screen'] });
    callback({ video: screen, audio: 'loopback' });
  });

  // Mirror renderer logs to the terminal.
  win.webContents.on('console-message', (event) => {
    console.log(`[renderer:${event.level}] ${event.message}`);
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('asr:get-status', () => asrStatus);

ipcMain.handle('asr:transcribe', async (_event, pcmBuffer, options) => {
  return whisper.transcribe(new Int16Array(pcmBuffer), options);
});

ipcMain.handle('meetings:create', (_event, id, startedAt, kind) => meetings.create(id, startedAt, kind === 'lesson' ? 'lesson' : 'meeting'));
ipcMain.handle('meetings:append-chunk', (_event, id, chunk) => meetings.appendChunk(id, chunk));
ipcMain.handle('meetings:finish', (_event, id) => meetings.finish(id));
ipcMain.handle('meetings:list', () => meetings.list());
ipcMain.handle('meetings:get', (_event, id) => meetings.get(id));
ipcMain.handle('meetings:reveal', (_event, id) => {
  const file = meetings.documentPath(id);
  if (file && fs.existsSync(file)) shell.showItemInFolder(file);
});
ipcMain.handle('meetings:open-folder', async () => {
  fs.mkdirSync(meetingsDir, { recursive: true });
  await shell.openPath(meetingsDir);
});

ipcMain.handle('theme:get', () => nativeTheme.themeSource);
ipcMain.handle('theme:set', (_event, theme) => {
  if (!THEMES.includes(theme)) throw new Error('unknown theme');
  nativeTheme.themeSource = theme;
  fs.writeFileSync(prefsFile, JSON.stringify({ ...readPrefs(), theme }));
  win?.setBackgroundColor(windowBackground());
});

// ---------- export ----------
const FONT_DIR = path.join(__dirname, 'renderer', 'fonts');
// Only files this session exported can be opened or revealed from the page.
const exportedFiles = new Set();

// Asks where to save (defaulting to the meeting's own name in the meetings
// folder), then writes a .pdf or .txt. Returns the saved path, or null if cancelled.
ipcMain.handle('meetings:export', async (_event, id, { format, includeTranscript }) => {
  if (!['pdf', 'txt'].includes(format)) throw new Error('unknown export format');
  const meeting = meetings.get(id);
  const base = (meeting.meta.file || `${id}.md`).replace(/\.md$/, '');
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: format === 'pdf' ? 'Export as PDF' : 'Export as text',
    defaultPath: path.join(meetingsDir, `${base}${includeTranscript ? ' (with transcript)' : ''}.${format}`),
    filters: [format === 'pdf' ? { name: 'PDF document', extensions: ['pdf'] } : { name: 'Text file', extensions: ['txt'] }],
  });
  if (canceled || !filePath) return null;
  if (format === 'txt') {
    fs.writeFileSync(filePath, toPlainText(meeting, { includeTranscript }), 'utf8');
  } else {
    const html = toPrintHtml(meeting, { includeTranscript, fontBase: pathToFileURL(FONT_DIR).href });
    fs.writeFileSync(filePath, await renderPdf(html, meeting.meta.title || 'Untitled recording'));
  }
  exportedFiles.add(filePath);
  return filePath;
});

ipcMain.handle('exports:open', (_event, file) => exportedFiles.has(file) && shell.openPath(file));
ipcMain.handle('exports:reveal', (_event, file) => exportedFiles.has(file) && shell.showItemInFolder(file));

let summaryBusy = false;

ipcMain.handle('summary:status', () => ({
  installed: summaryPack.isInstalled(),
  busy: summaryBusy,
  downloadGb: summaryPack.downloadGb,
}));

ipcMain.handle('summary:install', async () => {
  if (summaryBusy) throw new Error('Summaries are busy');
  summaryBusy = true;
  try {
    await summaryPack.install((progress) => send('summary:setup-progress', progress));
  } finally {
    summaryBusy = false;
  }
});

// Starts the model, summarizes, renames the meeting after its topic, then frees the GPU again.
// kind: 'meeting' or 'lesson'; omitted = the type the recording already has.
ipcMain.handle('summary:run', async (_event, id, language, kind) => {
  if (!summaryPack.isInstalled()) throw new Error('Summaries are not set up yet');
  if (summaryBusy) throw new Error('A summary is already running');
  const chunks = meetings.readChunks(id);
  const summaryKind = kind || meetings.readMeta(id).kind || 'meeting';
  summaryBusy = true;
  const progress = (label) => send('summary:progress', { id, label });
  const llm = new LlamaServer({
    cudaDir: summaryPack.cudaDir,
    cpuDir: summaryPack.cpuDir,
    modelPath: summaryPack.modelPath,
    onStatus: progress,
  });
  try {
    const started = Date.now();
    await llm.start();
    const summary = await summarizeTranscript({ chunks, labels: LABELS, language, kind: summaryKind, llm, onProgress: progress });
    const meta = meetings.setSummary(id, summary);
    console.log(`[summary] ${llm.engine}, ${chunks.length} chunks, ${Math.round((Date.now() - started) / 1000)} s -> ${meta.file}`);
    return { meta, engine: llm.engine };
  } finally {
    llm.stop();
    summaryBusy = false;
  }
});

app.whenReady().then(() => {
  migrateOldMeetings();
  lockNetwork();
  createWindow();
  whisper.start().catch((err) => {
    console.error(`[whisper] ${err.message}`);
    asrStatus = `error: ${err.message}`;
    send('asr:status', asrStatus);
  });
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => whisper.stop());
