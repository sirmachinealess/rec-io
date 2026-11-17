// Turns one audio source into transcript chunks using the local whisper-server.
// Finals are decoded in order; a partial is only sent when nothing else from this
// source is in flight, so live text never delays final text.
import { SAMPLE_RATE, Segmenter } from './segmenter.js';

export class LocalAsrStream {
  // onChunk({ id, source, text, isFinal, startMs, endMs }); getOptions() -> { language, prompt }
  constructor({ source, offsetMs, onChunk, onStatus, getOptions }) {
    this.source = source;
    this.offsetMs = offsetMs;
    this.onChunk = onChunk;
    this.onStatus = onStatus;
    this.getOptions = getOptions;
    this.segmenter = new Segmenter();
    this.finals = Promise.resolve();
    this.inFlight = 0;
    this.finalized = new Set();
    this.stopped = false;
    this.onStatus('listening');
  }

  push(frame) {
    if (this.stopped) return;
    for (const event of this.segmenter.push(new Int16Array(frame))) this.handle(event);
  }

  handle(event) {
    const chunkId = `${this.source}-${event.id}`;
    const timing = {
      startMs: this.offsetMs + Math.round((event.startSample / SAMPLE_RATE) * 1000),
      endMs: this.offsetMs + Math.round((event.endSample / SAMPLE_RATE) * 1000),
    };

    if (event.type === 'partial') {
      if (this.inFlight > 0) return;
      this.decode(event.samples).then((text) => {
        // A late partial must not overwrite the final for the same segment.
        if (text && !this.finalized.has(chunkId)) {
          this.onChunk({ id: chunkId, source: this.source, text, isFinal: false, ...timing });
        }
      });
      return;
    }

    this.finalized.add(chunkId);
    this.finals = this.finals.then(async () => {
      const text = await this.decode(event.samples);
      // Empty finals still go out so a visible partial for this id gets removed.
      this.onChunk({ id: chunkId, source: this.source, text, isFinal: true, ...timing });
    });
  }

  async decode(samples) {
    this.inFlight++;
    this.onStatus('transcribing');
    try {
      const { text } = await window.recio.transcribe(samples.buffer, this.getOptions());
      return text;
    } catch (err) {
      console.error(`[${this.source}] transcribe failed: ${err.message}`);
      return '';
    } finally {
      this.inFlight--;
      if (this.inFlight === 0) this.onStatus(this.stopped ? 'stopped' : 'listening');
    }
  }

  // Finish the open segment and wait until every final is decoded.
  async stop() {
    this.stopped = true;
    for (const event of this.segmenter.flush()) this.handle(event);
    await this.finals;
    this.onStatus('stopped');
  }
}
