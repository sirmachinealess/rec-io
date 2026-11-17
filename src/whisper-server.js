// Runs whisper.cpp's whisper-server on 127.0.0.1 and sends it audio segments.
// It listens on a random free port; we poll until it is ready, POST one WAV per
// speech segment to /inference, and kill the server on exit.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const SAMPLE_RATE = 16000;
const READY_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 120_000;

function findFile(dir, name, depth = 3) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name) return full;
    if (entry.isDirectory() && depth > 0) {
      const found = findFile(full, name, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function wavFromPcm16(pcm) {
  const dataBytes = pcm.byteLength;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, dataBytes).copy(buf, 44);
  return buf;
}

// Whisper invents text for noise and silence; drop the usual offenders.
const NON_SPEECH = /^\s*(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+|\.+)\s*$/;

class WhisperServer {
  constructor({ localDir, modelName, onStatus }) {
    this.localDir = localDir;
    this.modelPath = path.join(localDir, 'models', modelName);
    this.onStatus = onStatus;
    this.child = null;
    this.baseUrl = null;
    this.queue = Promise.resolve();
  }

  async start() {
    if (!fs.existsSync(this.modelPath)) {
      throw new Error(`Model not found at ${this.modelPath}. Run "npm run setup-local".`);
    }
    const builds = [
      ['GPU (CUDA)', findFile(path.join(this.localDir, 'whisper-cuda'), 'whisper-server.exe'), true],
      ['CPU', findFile(path.join(this.localDir, 'whisper-cpu'), 'whisper-server.exe'), false],
    ].filter(([, exe]) => exe);
    if (builds.length === 0) throw new Error('whisper-server.exe not found. Run "npm run setup-local".');

    let lastError;
    for (const [label, exe, requireGpu] of builds) {
      this.onStatus(`loading model (${label})…`);
      try {
        await this.launch(exe, requireGpu);
        // The first inference is slow (CUDA kernel warm-up, ~30 s on a cold
        // cache). Pay it now instead of on the meeting's first sentence.
        this.onStatus(`warming up (${label})…`);
        const warmupMs = (await this.request(new Int16Array(SAMPLE_RATE), 'en', '')).decodeMs;
        console.log(`[whisper] ${label} ready, warm-up took ${warmupMs} ms`);
        this.engine = label;
        this.onStatus(`ready · ${label}`);
        return label;
      } catch (err) {
        lastError = err;
        console.warn(`[whisper] ${label} build failed: ${err.message}`);
        this.stop();
      }
    }
    throw lastError;
  }

  async launch(exe, requireGpu) {
    const port = await freePort();
    const args = ['-m', this.modelPath, '--host', '127.0.0.1', '--port', String(port), '-l', 'auto', '--suppress-nst'];
    // cwd = the exe's folder so Windows finds the bundled ggml/CUDA DLLs.
    const child = spawn(exe, args, { cwd: path.dirname(exe), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    this.child = child;
    let stderrTail = '';
    child.stderr.on('data', (d) => (stderrTail = (stderrTail + d).slice(-2000)));

    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode === 0xc0e90002) {
        throw new Error('Windows Smart App Control blocked the transcription engine (its files are not digitally signed)');
      }
      if (child.exitCode !== null) {
        throw new Error(`whisper-server exited with code ${child.exitCode}: ${stderrTail.trim().split('\n').pop()}`);
      }
      let ready = false;
      try {
        ready = (await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(2000) })).ok;
      } catch {
        // Not listening yet.
      }
      if (ready) {
        // The CUDA build quietly falls back to CPU when its DLLs are missing.
        if (requireGpu && /no GPU found/i.test(stderrTail)) {
          throw new Error('CUDA backend did not load (missing cuBLAS DLLs? run "npm run setup-local")');
        }
        this.baseUrl = baseUrl;
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('whisper-server did not become ready in time');
  }

  // Requests run one at a time so two sources don't fight over the GPU.
  transcribe(pcm, { language = 'auto', prompt = '' } = {}) {
    const run = () => this.request(pcm, language, prompt);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async request(pcm, language, prompt) {
    if (!this.baseUrl) throw new Error('whisper-server is not running');
    const form = new FormData();
    form.append('file', new Blob([wavFromPcm16(pcm)], { type: 'audio/wav' }), 'segment.wav');
    form.append('temperature', '0.0');
    form.append('response_format', 'json');
    form.append('language', language);
    if (prompt) form.append('prompt', prompt);
    const started = performance.now();
    const res = await fetch(`${this.baseUrl}/inference`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`whisper-server inference failed: HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`whisper-server: ${json.error}`);
    const text = String(json.text ?? '').replace(/\s+/g, ' ').trim();
    return { text: NON_SPEECH.test(text) ? '' : text, decodeMs: Math.round(performance.now() - started) };
  }

  stop() {
    this.baseUrl = null;
    if (this.child && this.child.exitCode === null) this.child.kill();
    this.child = null;
  }
}

module.exports = { WhisperServer, wavFromPcm16, findFile, freePort };
