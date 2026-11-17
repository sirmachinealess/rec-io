// Checksum-verified downloads and zip extraction for the main process.
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

async function sha256File(file) {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

// Downloads to <dest>.part, verifies SHA-256, then renames into place.
async function downloadFile(url, dest, { sha256, onProgress } = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  let done = 0;
  const meter = new Transform({
    transform(chunk, _enc, callback) {
      hash.update(chunk);
      done += chunk.length;
      onProgress?.(done, total);
      callback(null, chunk);
    },
  });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(`${dest}.part`));
  const actual = hash.digest('hex');
  if (sha256 && actual !== sha256) {
    fs.rmSync(`${dest}.part`, { force: true });
    throw new Error(`Checksum mismatch for ${path.basename(dest)}`);
  }
  fs.renameSync(`${dest}.part`, dest);
}

// Windows 10+ ships bsdtar, which extracts zip files. Use it by full path:
// a GNU tar earlier on PATH (Git Bash) reads "C:" as a remote host.
function extractZip(zip, dir) {
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  fs.mkdirSync(dir, { recursive: true });
  return new Promise((resolve, reject) =>
    execFile(tar, ['-xf', zip, '-C', dir], { windowsHide: true }, (err) => (err ? reject(err) : resolve())),
  );
}

module.exports = { downloadFile, extractZip, sha256File };
