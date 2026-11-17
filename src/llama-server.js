// Runs llama.cpp's llama-server on 127.0.0.1 for summaries. Started on demand
// and stopped afterwards so it never holds GPU memory during a recording.
const { execFile, spawn } = require('node:child_process');
const path = require('node:path');
const { findFile, freePort } = require('./whisper-server');

const CONTEXT_TOKENS = 12288;
const READY_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 15 * 60_000;
// STATUS_SYSTEM_INTEGRITY_POLICY_VIOLATION (0xC0E90002): Windows Code Integrity,
// e.g. Smart App Control, refused to load an unsigned file.
const BLOCKED_BY_WINDOWS = 0xc0e90002;

class LlamaServer {
  constructor({ cudaDir, cpuDir, modelPath, onStatus = () => {} }) {
    this.cudaDir = cudaDir;
    this.cpuDir = cpuDir;
    this.modelPath = modelPath;
    this.onStatus = onStatus;
    this.child = null;
    this.baseUrl = null;
  }

  async start() {
    const builds = [
      ['GPU (CUDA)', findFile(this.cudaDir, 'llama-server.exe'), true],
      ['CPU', findFile(this.cpuDir, 'llama-server.exe'), false],
    ].filter(([, exe]) => exe);
    if (builds.length === 0) throw new Error('llama-server.exe not found; set up summaries first');

    let lastError;
    for (const [label, exe, useGpu] of builds) {
      this.onStatus(`loading summary model (${label})…`);
      try {
        await this.launch(exe, useGpu);
        this.engine = label;
        return label;
      } catch (err) {
        lastError = err;
        console.warn(`[llama] ${label} build failed: ${err.message}`);
        this.stop();
      }
    }
    throw lastError;
  }

  // Asks the build which devices it can use; the CUDA build without a working
  // GPU lists none and would silently run on the CPU.
  listsCudaDevice(exe) {
    return new Promise((resolve) => {
      execFile(exe, ['--list-devices'], { cwd: path.dirname(exe), timeout: 30_000, windowsHide: true }, (_err, stdout, stderr) =>
        resolve(/^\s*CUDA\d+:/m.test(`${stdout}\n${stderr}`)),
      );
    });
  }

  async launch(exe, useGpu) {
    if (useGpu && !(await this.listsCudaDevice(exe))) throw new Error('no CUDA device available to this build');
    const port = await freePort();
    const args = [
      '-m', this.modelPath,
      '--host', '127.0.0.1',
      '--port', String(port),
      '-c', String(CONTEXT_TOKENS),
      '--parallel', '1',
      '--no-webui',
      '-ngl', useGpu ? '99' : '0',
    ];
    // Quantized KV cache halves its memory; it needs flash attention.
    if (useGpu) args.push('-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0');

    // cwd = the exe's folder so Windows finds the ggml/CUDA DLLs next to it.
    const child = spawn(exe, args, { cwd: path.dirname(exe), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    this.child = child;
    let stderrTail = '';
    child.stderr.on('data', (d) => (stderrTail = (stderrTail + d).slice(-3000)));

    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode === BLOCKED_BY_WINDOWS) {
        throw new Error('Windows Smart App Control blocked the summary engine (its files are not digitally signed)');
      }
      if (child.exitCode !== null) {
        const lastLine = stderrTail.trim().split('\n').filter(Boolean).pop() ?? '';
        throw new Error(`llama-server exited with code ${child.exitCode}: ${lastLine}`);
      }
      let ready = false;
      try {
        // /health answers 503 while the model loads and 200 once it can serve.
        ready = (await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) })).ok;
      } catch {
        // Not listening yet.
      }
      if (ready) {
        this.baseUrl = baseUrl;
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('llama-server did not become ready in time');
  }

  // Chat completion constrained to a JSON schema (llama.cpp turns it into a grammar).
  async chatJson(messages, schema, { maxTokens = 3000, temperature = 0.2 } = {}) {
    if (!this.baseUrl) throw new Error('llama-server is not running');
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_schema', json_schema: { name: 'meeting_summary', schema } },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`llama-server: ${body.error?.message || `HTTP ${res.status}`}`);
    const choice = body.choices?.[0];
    if (choice?.finish_reason === 'length') throw new Error('Summary was cut off (output too long)');
    return JSON.parse(choice?.message?.content ?? '');
  }

  stop() {
    this.baseUrl = null;
    if (this.child && this.child.exitCode === null) this.child.kill();
    this.child = null;
  }
}

module.exports = { LlamaServer, CONTEXT_TOKENS };
