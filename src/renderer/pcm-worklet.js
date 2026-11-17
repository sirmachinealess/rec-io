// Runs on the audio thread. The AudioContext is created at 16 kHz, so Chromium
// has already resampled; this converts Float32 to Int16 PCM (Deepgram `linear16`)
// and posts ~100 ms frames.
const FRAME_SAMPLES = 1600;

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(FRAME_SAMPLES);
    this.length = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.length++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.length === FRAME_SAMPLES) {
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
        this.buffer = new Int16Array(FRAME_SAMPLES);
        this.length = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm', PcmProcessor);
