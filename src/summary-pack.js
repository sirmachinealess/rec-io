// The optional summary engine: llama.cpp (CUDA + CPU builds) and the Qwen3 4B
// model, downloaded once into the app's data folder. Too large to ship inside
// the installer (NSIS caps installers at 2 GB).
const fs = require('node:fs');
const path = require('node:path');
const { downloadFile, extractZip, sha256File } = require('./download');

const LLAMA_BUILD = 'b11190';
const LLAMA_RELEASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}`;
const MODEL_FILE = 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf';

const ASSETS = [
  {
    target: 'llama-cuda',
    url: `${LLAMA_RELEASE}/llama-${LLAMA_BUILD}-bin-win-cuda-12.4-x64.zip`,
    sha256: 'dd2224044307676d983d4c0b8b7946f2f59c23082e26172cf2adb30b73e88be9',
    bytes: 262e6,
  },
  {
    // CUDA 12.4 runtime + cuBLAS, extracted next to the CUDA llama-server.
    target: 'llama-cuda',
    url: `${LLAMA_RELEASE}/cudart-llama-bin-win-cuda-12.4-x64.zip`,
    sha256: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
    bytes: 391e6,
  },
  {
    target: 'llama-cpu',
    url: `${LLAMA_RELEASE}/llama-${LLAMA_BUILD}-bin-win-cpu-x64.zip`,
    sha256: '0a1f14c164adb35a411daf4b3c061ef02e2e1f1898f5e9b1a957f6a80dfa1c41',
    bytes: 19e6,
  },
  {
    target: `models/${MODEL_FILE}`,
    url: `https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/${MODEL_FILE}`,
    sha256: '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597',
    bytes: 2.5e9,
  },
];
const TOTAL_BYTES = ASSETS.reduce((sum, a) => sum + a.bytes, 0);

class SummaryPack {
  constructor(root) {
    this.root = root;
    this.marker = path.join(root, 'installed.json');
  }

  get cudaDir() { return path.join(this.root, 'llama-cuda'); }
  get cpuDir() { return path.join(this.root, 'llama-cpu'); }
  get modelPath() { return path.join(this.root, 'models', MODEL_FILE); }
  get downloadGb() { return (TOTAL_BYTES / 1e9).toFixed(1); }

  isInstalled() {
    try {
      return JSON.parse(fs.readFileSync(this.marker, 'utf8')).build === LLAMA_BUILD && fs.existsSync(this.modelPath);
    } catch {
      return false;
    }
  }

  // onProgress({ pct, label }). Finished downloads are cached in ./downloads, so
  // an interrupted setup resumes at the file it stopped on.
  async install(onProgress) {
    const downloads = path.join(this.root, 'downloads');
    const staging = path.join(this.root, 'staging');
    fs.rmSync(staging, { recursive: true, force: true });
    let doneBefore = 0;

    for (const asset of ASSETS) {
      const file = path.join(downloads, path.basename(new URL(asset.url).pathname));
      const name = path.basename(file);
      const report = (done) =>
        onProgress({ pct: Math.min(99, Math.floor(((doneBefore + done) / TOTAL_BYTES) * 100)), label: `Downloading ${name}` });

      let cached = false;
      if (fs.existsSync(file)) {
        onProgress({ pct: Math.floor((doneBefore / TOTAL_BYTES) * 100), label: `Verifying ${name}` });
        cached = (await sha256File(file)) === asset.sha256;
      }
      if (!cached) await downloadFile(asset.url, file, { sha256: asset.sha256, onProgress: report });
      doneBefore += asset.bytes;

      if (file.endsWith('.zip')) {
        onProgress({ pct: Math.floor((doneBefore / TOTAL_BYTES) * 100), label: `Unpacking ${name}` });
        await extractZip(file, path.join(staging, asset.target));
      } else {
        fs.mkdirSync(path.dirname(path.join(staging, asset.target)), { recursive: true });
        fs.renameSync(file, path.join(staging, asset.target));
      }
    }

    for (const dir of ['llama-cuda', 'llama-cpu', 'models']) {
      fs.rmSync(path.join(this.root, dir), { recursive: true, force: true });
      fs.renameSync(path.join(staging, dir), path.join(this.root, dir));
    }
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(downloads, { recursive: true, force: true });
    fs.writeFileSync(this.marker, JSON.stringify({ build: LLAMA_BUILD, model: MODEL_FILE, installedAt: new Date().toISOString() }));
    onProgress({ pct: 100, label: 'Summaries are ready' });
  }
}

module.exports = { SummaryPack };
