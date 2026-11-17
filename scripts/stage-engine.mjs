// Copies only the files whisper-server needs from ./local into ./build/engine,
// which electron-builder ships as resources/local inside the installed app.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = path.join(ROOT, 'local');
const OUT = path.join(ROOT, 'build', 'engine');
const MODEL = process.env.WHISPER_MODEL || 'ggml-large-v3-turbo-q5_0.bin';

// whisper-server.exe imports whisper/ggml/ggml-base; ggml loads ggml-cpu-*.dll and
// ggml-cuda.dll at runtime; ggml-cuda imports cuBLAS and the CUDA runtime.
const COMMON = [/^whisper-server\.exe$/i, /^whisper\.dll$/i, /^ggml\.dll$/i, /^ggml-base\.dll$/i, /^ggml-cpu-.*\.dll$/i];
const CUDA = [/^ggml-cuda\.dll$/i, /^cublas64_11\.dll$/i, /^cublasLt64_11\.dll$/i, /^cudart64_110\.dll$/i];

function stage(build, patterns, required) {
  const src = path.join(LOCAL, build, 'Release');
  if (!existsSync(path.join(src, 'whisper-server.exe'))) throw new Error(`${src} is missing; run "npm run setup-local"`);
  const dest = path.join(OUT, build);
  mkdirSync(dest, { recursive: true });
  const copied = readdirSync(src).filter((f) => patterns.some((p) => p.test(f)));
  for (const f of copied) copyFileSync(path.join(src, f), path.join(dest, f));
  for (const name of required) {
    if (!copied.some((f) => f.toLowerCase() === name.toLowerCase())) throw new Error(`${build}: ${name} not found in ${src}`);
  }
  return copied.length;
}

rmSync(OUT, { recursive: true, force: true });
const cuda = stage('whisper-cuda', [...COMMON, ...CUDA], ['whisper-server.exe', 'ggml-cuda.dll', 'cublas64_11.dll', 'cublasLt64_11.dll']);
const cpu = stage('whisper-cpu', COMMON, ['whisper-server.exe']);

const model = path.join(LOCAL, 'models', MODEL);
if (!existsSync(model)) throw new Error(`${model} is missing; run "npm run setup-local"`);
mkdirSync(path.join(OUT, 'models'), { recursive: true });
copyFileSync(model, path.join(OUT, 'models', MODEL));

let bytes = 0;
const walk = (d) => readdirSync(d).forEach((f) => {
  const p = path.join(d, f);
  statSync(p).isDirectory() ? walk(p) : (bytes += statSync(p).size);
});
walk(OUT);
console.log(`staged ${cuda} CUDA files, ${cpu} CPU files and ${MODEL}: ${(bytes / 1e9).toFixed(2)} GB in build/engine`);
