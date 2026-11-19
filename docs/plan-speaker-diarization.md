# Plan: speaker separation for the "Them" channel (v1.6.0)

> **Status (2026-11-19): all phases (0–5) done**, shipped in v1.6.0. Engine: sherpa-onnx 2.0.1 with
> pyannote segmentation 3.0 + 3D-Speaker CAM++ (English), plus a merge pass against over-splitting.

Task file for Claude Code. Work through the phases in order, stop after each phase,
show me what changed and wait for my OK before starting the next one.

## Goal

Today every line from the computer's sound is labelled **Them**, so in a call with
three other people the summary cannot say *who* agreed to what. After this change,
lines from the system channel are labelled **Speaker 1, Speaker 2, …**, and the
summary's action items use those labels as owners.

Background: GitHub issue "Speaker diarization for the 'Them' channel (after Stop)",
which came from Reddit feedback.

## Rules that must not break

1. **Offline.** `main.js` blocks every network request except local files and
   `127.0.0.1`. Diarization must run fully locally. Any model download happens only in
   an explicit, user-started setup step (like **Set up summaries** in
   `src/summary-pack.js`), with every file SHA-256-verified.
2. **Text only on disk.** rec.io never keeps audio. The temporary audio for
   diarization is deleted as soon as diarization finishes, also when it fails or the
   app is closed mid-way (clean up leftovers on next start).
3. **Never during the call.** Diarization runs only after **Stop**, before the
   summary, so it never competes with Whisper for GPU memory while recording.
4. **Optional and safe.** It is a setting ("Separate speakers", off by default until it
   is stable). If it is off, not set up, or fails, everything works exactly as today
   with the plain "Them" label. A failure must never lose the transcript.
5. **Tests stay green.** `npm test` must pass after every phase, and new logic gets
   tests (CI runs them on every push).

## How the code works today (relevant parts)

- `src/renderer/capture.js`: `startPcmCapture()` delivers 16 kHz Int16 PCM frames per
  source (`microphone`, `system`).
- `src/renderer/app.js` → `startSource()`: pushes each frame into a `LocalAsrStream`;
  final chunks `{ id, source, text, isFinal, startMs, endMs }` are saved via
  `window.recio.appendChunk()`. `startMs`/`endMs` are relative to the recording start.
- `src/renderer/app.js` → `stopRecording()`: stops all sources, calls
  `finishMeeting()`, then starts the summary if auto-summary is on.
- `src/meetings.js`: stores chunks in `.data/<id>/transcript.jsonl`;
  `LABELS = { microphone: 'Me', system: 'Them' }` is used when building the Markdown
  document.
- `src/summary-format.js` → `formatTranscript()`: joins consecutive chunks of the same
  `source` into one turn and labels it with `labels[source]`.
- `src/main.js`: IPC handlers; `summary:run` loads chunks, runs the LLM, saves the
  summary. Engines (`whisper-server`, `llama-server`) are separate local processes.

## Phase 0: choose the engine (research only, no code)

Compare two options and recommend one with reasons (speed on an RTX 2060 SUPER /
8 GB, install size, licence, how it fits an Electron app, Windows support):

- **A. sherpa-onnx** (ONNX runtime, has Node.js bindings and an offline speaker
  diarization API using pyannote segmentation + speaker-embedding models). No Python,
  no PyTorch; could run inside the main process or a small Node worker.
- **B. pyannote.audio** (Python + PyTorch) as a small local helper process, started
  like `whisper-server`. Most accurate and widely used, but adds Python and a large
  PyTorch install; the models are gated on Hugging Face (accept terms, token needed for
  the one-time download).

Also answer: which exact models, their licences, total download size, and whether they
can be redistributed or must be downloaded by the user at setup.

**Stop and report.** I decide before Phase 1.

## Phase 1: keep the system audio temporarily

- New IPC `meetings:append-audio` (and the matching `preload.js` method) that appends
  raw Int16 PCM frames of the **system** source to
  `%APPDATA%\rec.io\tmp\<recording id>-system.pcm`. Only when "Separate speakers" is on.
- In `startSource()`, forward system frames to it (batched, e.g. every ~1 s, not per
  frame). The microphone is never saved.
- On app start, delete leftover files in `tmp\`.
- Tests: writing/appending/cleanup in a temp folder.

## Phase 2: run diarization after Stop

- New module `src/diarize.js` (plus a setup/download module modelled on
  `summary-pack.js`) that takes the PCM file and returns
  `[{ startMs, endMs, speaker }]`, with `speaker` as `0, 1, 2, …`.
- New IPC `diarize:run`, called from `stopRecording()` **after** `finishMeeting()` and
  **before** `runSummary()`. Show progress in the UI ("Separating speakers…").
- Always delete the PCM file afterwards (`finally`).
- Settings: "Separate speakers" toggle plus a **Set up speaker separation** button
  for the one-time, verified model download.

## Phase 3: put the speakers onto the transcript

- Pure function (easy to test), e.g. `assignSpeakers(chunks, turns)`: for every chunk
  with `source === 'system'`, pick the speaker whose turns overlap it most; store it as
  `chunk.speaker` (e.g. `"Speaker 1"`). Chunks with no overlap keep "Them".
  Microphone chunks are never changed.
- Persist the result (rewrite `transcript.jsonl` atomically, or store a
  `speakers.json` mapping next to it; choose the simpler one and explain).
- `formatTranscript()` and the Markdown builder in `meetings.js` use `chunk.speaker`
  when present, else `labels[source]`. A change of speaker must start a new turn even
  within the same source.
- The live view keeps showing "Them" during the call; the saved recording shows
  Speaker 1/2/… afterwards.
- Tests: overlap mapping (clear overlap, tie, no overlap, single speaker), transcript
  formatting with speakers, old recordings without `speaker` still render as before.

## Phase 4: summary, rename and docs

- Make sure the summary prompt explains the labels (Me / Speaker 1 / Speaker 2) so
  action-item owners use them. Optional: let the user rename "Speaker 1" to a real name
  on the recording page, and re-run the summary with **Redo**.
- Measure on my RTX 2060 SUPER with a test call of 3 voices: extra time after Stop and
  peak VRAM (`nvidia-smi --query-gpu=memory.used --format=csv -l 1`). Add both to the
  "At a glance" line and the Requirements section of `README.md`.
- README: new feature section, move the "Them is one bucket" point out of Known limits,
  and keep the headphones note.

## Phase 5: release

- Bump `version` in `package.json` to `1.6.0`, `npm test`, `npm run dist`.
- One commit per phase with clear messages; push to `main`.
- I create the GitHub Release `v1.6.0` with the installer and close the issue with a
  link to the commit.

## Definition of done

- A 3-voice test call shows Speaker 1/2/3 on the right lines most of the time, and the
  summary's action items name the right speaker.
- With the setting off, behaviour is identical to v1.5.1.
- No audio file remains on disk after a recording (also after a crash and restart).
- `npm test` passes locally and on GitHub Actions.
- README shows the measured extra time and VRAM.
