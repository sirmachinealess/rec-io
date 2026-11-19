// Collects ~100 ms Int16 PCM frames and hands them on in ~1 s batches, so the
// system audio for speaker separation is sent over IPC once a second instead
// of ten times. Frames are copied: the caller may keep using its own buffer.
import { SAMPLE_RATE } from './segmenter.js';

export class AudioBatcher {
  // send(ArrayBuffer) is called with whole batches; batchSamples defaults to 1 s.
  constructor(send, batchSamples = SAMPLE_RATE) {
    this.send = send;
    this.batchSamples = batchSamples;
    this.parts = [];
    this.length = 0;
  }

  push(frame) {
    const samples = new Int16Array(frame);
    if (samples.length === 0) return;
    this.parts.push(samples.slice());
    this.length += samples.length;
    if (this.length >= this.batchSamples) this.flush();
  }

  // Sends whatever is buffered (also a partial batch, e.g. on Stop).
  flush() {
    if (this.length === 0) return;
    const batch = new Int16Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      batch.set(part, offset);
      offset += part.length;
    }
    this.parts = [];
    this.length = 0;
    this.send(batch.buffer);
  }
}
