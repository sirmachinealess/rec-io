const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, payload) => callback(payload));

contextBridge.exposeInMainWorld('recio', {
  getAsrStatus: () => ipcRenderer.invoke('asr:get-status'),
  onAsrStatus: on('asr:status'),
  transcribe: (pcmBuffer, options) => ipcRenderer.invoke('asr:transcribe', pcmBuffer, options),

  createMeeting: (id, startedAt, kind) => ipcRenderer.invoke('meetings:create', id, startedAt, kind),
  appendChunk: (id, chunk) => ipcRenderer.invoke('meetings:append-chunk', id, chunk),
  finishMeeting: (id) => ipcRenderer.invoke('meetings:finish', id),
  appendAudio: (id, pcm) => ipcRenderer.invoke('meetings:append-audio', id, pcm),
  discardAudio: (id) => ipcRenderer.invoke('meetings:discard-audio', id),
  listMeetings: () => ipcRenderer.invoke('meetings:list'),
  getMeeting: (id) => ipcRenderer.invoke('meetings:get', id),
  revealMeeting: (id) => ipcRenderer.invoke('meetings:reveal', id),
  openMeetingsFolder: () => ipcRenderer.invoke('meetings:open-folder'),
  exportMeeting: (id, options) => ipcRenderer.invoke('meetings:export', id, options),
  openExport: (file) => ipcRenderer.invoke('exports:open', file),
  revealExport: (file) => ipcRenderer.invoke('exports:reveal', file),

  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),

  getSummaryStatus: () => ipcRenderer.invoke('summary:status'),
  installSummaries: () => ipcRenderer.invoke('summary:install'),
  onSummarySetupProgress: on('summary:setup-progress'),
  summarize: (id, language, kind) => ipcRenderer.invoke('summary:run', id, language, kind),
  onSummaryProgress: on('summary:progress'),

  getSpeakerStatus: () => ipcRenderer.invoke('speakers:status'),
  installSpeakers: () => ipcRenderer.invoke('speakers:install'),
  onSpeakerSetupProgress: on('speakers:setup-progress'),
  separateSpeakers: (id, options) => ipcRenderer.invoke('diarize:run', id, options),
  onDiarizeProgress: on('diarize:progress'),
});
