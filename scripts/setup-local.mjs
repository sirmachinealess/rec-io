// Downloads whisper.cpp (CUDA + CPU builds), NVIDIA cuBLAS and the Whisper model into ./local.
// Usage: npm run setup-local
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const LOCAL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'local');
const WHISPER_BUILD = 'b5130';
const RELEASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_BUILD}`;
const CUDA_BIN = path.join(LOCAL, 'whisper-cuda', 'Release');

// The whisper.cpp CUDA build does not bundle cuBLAS; without these two DLLs it
// silently runs on the CPU. NVIDIA's redistributable for CUDA 11.8:
const CUBLAS = {
  url: 'https://developer.download.nvidia.com/compute/cuda/redist/libcublas/windows-x86_64/libcublas-windows-x86_64-11.11.3.6-archive.zip',
  sha256: '67b0934a6359e4ee26fff823c356021589d392c4fd49ca12624f570edc08e2b9',
  dlls: ['cublas64_11.dll', 'cublasLt64_11.dll'],
};

const DOWNLOADS = [
  { name: 'whisper-cpu', url: `${RELEASE}/whisper-bin-x64.zip`, unzip: true },
  { name: 'whisper-cuda', url: `${RELEASE}/whisper-cublas-11.8.0-bin-x64.zip`, unzip: true, optional: true },
  {
    name: 'models/ggml-large-v3-turbo-q5_0.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
  },
];

// Windows 10+ ships bsdtar, which extracts zip files. Use it by full path:
// a GNU tar earlier on PATH (Git Bash) reads "C:" as a remote host.
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  let lastPct = -10;
  const body = Readable.fromWeb(res.body);
  body.on('data', (b) => {
    done += b.length;
    const pct = total ? Math.floor((done / total) * 100) : 0;
    if (pct >= lastPct + 10) {
      lastPct = pct;
      console.log(`  ${path.basename(dest)} ${pct}%`);
    }
  });
  await pipeline(body, createWriteStream(dest));
}

async function sha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return full;
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    }
  }
  return null;
}

for (const item of DOWNLOADS) {
  const target = path.join(LOCAL, item.name);
  if (existsSync(target)) {
    console.log(`skip ${item.name} (already present)`);
    continue;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  console.log(`download ${item.url}`);
  try {
    if (!item.unzip) {
      await download(item.url, `${target}.part`);
      renameSync(`${target}.part`, target);
      continue;
    }
    const zip = `${target}.zip`;
    await download(item.url, zip);
    mkdirSync(`${target}.part`, { recursive: true });
    execFileSync(TAR, ['-xf', zip, '-C', `${target}.part`]);
    rmSync(zip);
    renameSync(`${target}.part`, target);
  } catch (err) {
    if (!item.optional) throw err;
    console.warn(`optional ${item.name} failed: ${err.message}`);
  }
}

if (existsSync(CUDA_BIN) && !CUBLAS.dlls.every((d) => existsSync(path.join(CUDA_BIN, d)))) {
  const zip = path.join(LOCAL, 'cublas.zip');
  const tmp = path.join(LOCAL, 'cublas.part');
  console.log(`download ${CUBLAS.url}`);
  try {
    await download(CUBLAS.url, zip);
    const actual = await sha256(zip);
    if (actual !== CUBLAS.sha256) throw new Error(`cuBLAS checksum mismatch: ${actual}`);
    mkdirSync(tmp, { recursive: true });
    execFileSync(TAR, ['-xf', zip, '-C', tmp]);
    for (const dll of CUBLAS.dlls) {
      const src = findFile(tmp, dll);
      if (!src) throw new Error(`${dll} not found in cuBLAS archive`);
      copyFileSync(src, path.join(CUDA_BIN, dll));
    }
    console.log('cuBLAS installed next to the CUDA whisper-server');
  } catch (err) {
    console.warn(`cuBLAS failed (GPU build will be skipped, CPU is used): ${err.message}`);
  } finally {
    rmSync(zip, { force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
}
console.log('local setup complete');
