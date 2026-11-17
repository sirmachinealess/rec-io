# rec.io

**An offline meeting recorder for Windows.** It transcribes your calls live and writes a structured summary (decisions, action items, open questions) when you stop. Everything runs on your own PC: no account, no API key, and no audio or text ever leaves the machine.

![rec.io demo](docs/demo.gif)

> Works with Zoom, Teams, Meet or any other call app. rec.io records the computer's sound and your microphone; nothing joins the call.

## Why I built it

AI meeting notes are useful, but most tools send your audio to the cloud. I wanted the same result for meetings and language lessons without any of it leaving my laptop, so I built one around open models that run locally on a consumer GPU.

## Features

- **Live transcription** with [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`large-v3-turbo`, multilingual, auto language detection). About 330 ms per speech segment on an RTX 2060 SUPER.
- **Me / Them labels**: the microphone and the system sound are recorded as separate sources.
- **Structured summaries** with a local LLM ([Qwen3-4B-Instruct-2507](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507) via [llama.cpp](https://github.com/ggml-org/llama.cpp)): title, overview, topics, decisions, action items (task, owner, due date) and open questions.
- **Language-lesson mode**: turns a class recording into study notes with grammar rules, a vocabulary table (article, plural, meaning, example), corrections, exercises and homework.
- **Long meetings**: transcripts longer than the model's context are summarized in parts and then merged.
- **Export** to PDF or TXT. Every recording is also saved as a readable Markdown file named after its topic.
- Light and dark mode; custom vocabulary so names and technical terms are spelled correctly.

## How it works

```
mic ───┐                          ┌─ Segmenter (VAD) ─┐
       ├─ AudioWorklet 16k PCM ───┤  per source       ├─► WAV ─► whisper-server on 127.0.0.1 (GPU)
system ┘  (WASAPI loopback)       └───────────────────┘                    │ text
                                                                            ▼
                                    TranscriptStore: partial (faded) → final, Me/Them by time
                                                     │  on Stop
                                                     ▼
                               llama-server (Qwen3-4B) ─► JSON-schema summary ─► Markdown / PDF
```

1. An energy-based voice activity detector cuts each audio stream into speech segments (32 ms hops, a segment closes after 0.8 s of silence, hard cut at 25 s).
2. Each segment is sent to a local `whisper-server`. Live partials appear faded and become solid once the final text arrives.
3. When you click **Stop**, rec.io starts `llama-server`, generates the summary, and shuts the model down again so it never holds GPU memory during a recording.

### Making a small model reliable

A 4B model running locally drifts and invents things, so the summary model's output is constrained by a **JSON schema**, and in lesson mode several steps are checked in code instead of trusted to the model:

- A second, narrow pass translates only the explanation fields. Words in the language being taught, and every number, are **masked** so the model cannot change them (German number words are converted to digits first).
- Example sentences are kept **only if they were actually said**, checked against the transcript.
- A plural the teacher said out loud (*"die Erfahrungen"*) **overrides** the model's guess.

### How it stays offline

- The UI's Content-Security-Policy sets `connect-src 'none'`, so the page cannot make network requests.
- The main process cancels every request that is not a local file or `127.0.0.1` / `localhost`.
- Spellcheck is disabled, because Chromium would download dictionaries.
- `whisper-server` and `llama-server` listen on `127.0.0.1` only, on random ports.

The only network access is the one-time model download, and only when you start it.

## Requirements

- Windows 10 or 11 (system audio is captured through WASAPI loopback)
- An NVIDIA GPU is strongly recommended. On CPU only, use a smaller Whisper model (see below).
- About 5 GB of free disk space for the engines and models
- Microsoft Visual C++ 2015–2022 runtime (already present on most PCs)
- Node.js (current LTS) and npm to build from source

## Getting started

```bash
git clone https://github.com/sirmachinealess/rec-io.git
cd rec-io
npm install
npm run setup-local   # downloads whisper.cpp, cuBLAS and the Whisper model into local/ (~1.3 GB)
npm start
```

Wait for **Engine: ready · GPU (CUDA)**, then click **Start**. The summary engine (llama.cpp and Qwen3-4B, ~3.2 GB, every file SHA-256-verified) is downloaded once from inside the app with **Set up summaries**.

To use a smaller Whisper model, for example on a machine without an NVIDIA GPU, put it in `local/models/` and run:

```bash
set WHISPER_MODEL=ggml-small.bin && npm start
```

### Build a Windows installer

```bash
npm run dist
```

This creates `dist/rec.io-Setup-<version>.exe` with the transcription engine bundled. The installer is not code-signed, so Windows SmartScreen will warn on first run (**More info → Run anyway**).

## Where your recordings are saved

```
%APPDATA%\rec.io\meetings\
  2026-10-20 21.44 – Project timeline and design document update.md   ← summary + transcript
  .data\<recording id>\meta.json, transcript.jsonl, summary.json      ← raw data used by the app
```

Recordings stay on your PC and are kept when you uninstall the app.

## Project structure

| Path | Role |
|---|---|
| `src/main.js` | Electron main process: window, loopback capture, network lock, IPC, saving |
| `src/whisper-server.js` | Starts whisper-server (CUDA, else CPU), queues `/inference` requests, filters `[BLANK_AUDIO]`-style output |
| `src/llama-server.js` | Starts and stops llama-server; JSON-schema chat completions |
| `src/summarize.js` | Single-pass or multi-part summaries, lesson-mode checks |
| `src/summary-format.js` | Schemas, prompts and Markdown rendering |
| `src/summary-pack.js` | One-time, checksum-verified download of the summary engine |
| `src/meetings.js` | Per-recording storage and topic-based file names |
| `src/export-format.js`, `src/pdf-export.js` | TXT and PDF export |
| `src/renderer/segmenter.js` | Energy-based voice activity detection |
| `src/renderer/local-asr.js` | Orders final segments; schedules live partials |
| `src/renderer/transcript.js` | Live merge of partial and final transcript chunks |
| `test/` | Unit tests (`npm test`) |

## Known limits

- Use headphones: speaker audio leaking into the microphone is transcribed twice.
- The voice detection is energy-based, so a loud fan or music can open segments. Whisper usually returns nothing for those, and that output is filtered. [Silero VAD](https://github.com/snakers4/silero-vad) would be the upgrade.
- Whisper occasionally invents a short phrase from microphone noise. Filtering on its no-speech probability would remove most of these.
- The first run after installing or updating the GPU driver spends ~30 s compiling CUDA kernels.
- In lesson mode, plurals the teacher did not say come from the model and can be wrong.

## Roadmap

- [ ] Silero VAD instead of the energy-based detector
- [ ] Measured transcription accuracy (word error rate) on a small test set
- [ ] Speaker diarization within the "Them" channel
- [ ] macOS support

## Built with

[whisper.cpp](https://github.com/ggml-org/whisper.cpp) · [llama.cpp](https://github.com/ggml-org/llama.cpp) · [Qwen3](https://github.com/QwenLM/Qwen3) · [Electron](https://www.electronjs.org/) · [Inter](https://rsms.me/inter/) (SIL Open Font License)

I built rec.io with [Claude Code](https://claude.com/claude-code) as my pair programmer.

## License

[MIT](LICENSE) © 2026 Felipe Silva. Models downloaded at setup keep their own licenses: Whisper (MIT), Qwen3 (Apache 2.0). NVIDIA cuBLAS is downloaded from NVIDIA under its own license.
