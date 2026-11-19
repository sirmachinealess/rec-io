// Temporary system-channel audio for speaker separation.
// rec.io never keeps audio: these files exist only between the start of a
// recording and the end of speaker separation, and are deleted afterwards.
// Leftovers (crash, app closed mid-way) are removed on the next start.
//   %APPDATA%\rec.io\tmp\<recording id>-system.pcm  (raw 16 kHz mono Int16 LE)
const fs = require('node:fs');
const path = require('node:path');

const ID_PATTERN = /^\d{4}-\d{2}-\d{2}T[\d-]+Z$/;
// One IPC batch is ~1 s (32 KB); anything far larger is a bug, not audio.
const MAX_APPEND_BYTES = 1024 * 1024;

class TempAudio {
  constructor(dir) {
    this.dir = dir;
  }

  path(id) {
    if (!ID_PATTERN.test(id)) throw new Error('invalid meeting id');
    return path.join(this.dir, `${id}-system.pcm`);
  }

  // data: ArrayBuffer, typed array or Buffer of Int16 samples.
  append(id, data) {
    const bytes = Buffer.isBuffer(data)
      ? data
      : ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : null;
    if (!bytes) throw new Error('audio must be binary');
    if (bytes.byteLength % 2 !== 0) throw new Error('audio must be whole Int16 samples');
    if (bytes.byteLength > MAX_APPEND_BYTES) throw new Error('audio batch too large');
    if (bytes.byteLength === 0) return;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.path(id), bytes);
  }

  exists(id) {
    return fs.existsSync(this.path(id));
  }

  remove(id) {
    fs.rmSync(this.path(id), { force: true });
  }

  // Deletes everything in tmp\. Returns how many entries were removed.
  cleanup() {
    if (!fs.existsSync(this.dir)) return 0;
    let removed = 0;
    for (const name of fs.readdirSync(this.dir)) {
      try {
        fs.rmSync(path.join(this.dir, name), { recursive: true, force: true });
        removed++;
      } catch (err) {
        console.warn(`[temp-audio] could not delete ${name}: ${err.message}`);
      }
    }
    return removed;
  }
}

module.exports = { TempAudio, MAX_APPEND_BYTES };
