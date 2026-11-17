// Energy-based voice activity detection that cuts a 16 kHz stream into speech
// segments. Timings: 512-sample hops (32 ms), 8 hops of
// pre-roll, close after 25 silent hops (~0.8 s), hard cut at 25 s, ignore
// segments with fewer than 6 speech hops.
export const SAMPLE_RATE = 16000;
export const HOP = 512;
const PREROLL_HOPS = 8;
const SILENCE_CLOSE_HOPS = 25;
const MAX_SEGMENT_HOPS = Math.floor((25 * SAMPLE_RATE) / HOP);
const MIN_SPEECH_HOPS = 6;
const PARTIAL_EVERY_HOPS = 47; // ~1.5 s

// RMS on a 0..1 scale. Speech must beat both an absolute floor and 3x the
// tracked background noise.
const ABS_THRESHOLD = 0.012;
const NOISE_RATIO = 3;

function rms(hop) {
  let sum = 0;
  for (let i = 0; i < hop.length; i++) {
    const s = hop[i] / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / hop.length);
}

function concat(hops) {
  const out = new Int16Array(hops.length * HOP);
  hops.forEach((h, i) => out.set(h, i * HOP));
  return out;
}

export class Segmenter {
  constructor() {
    this.pending = new Int16Array(0);
    this.hopIndex = 0; // hops consumed so far
    this.noiseFloor = 0.002;
    this.ring = []; // recent idle hops, used as pre-roll
    this.open = null; // { id, startHop, hops, speechHops, silenceRun, hopsSincePartial }
    this.nextId = 0;
  }

  // Returns events: { type: 'partial' | 'final', id, startSample, endSample, samples }
  push(frame) {
    const events = [];
    let data = frame;
    if (this.pending.length) {
      data = new Int16Array(this.pending.length + frame.length);
      data.set(this.pending);
      data.set(frame, this.pending.length);
    }
    let offset = 0;
    for (; offset + HOP <= data.length; offset += HOP) {
      this.consumeHop(data.slice(offset, offset + HOP), events);
    }
    this.pending = data.slice(offset);
    return events;
  }

  // Close whatever is open (call when recording stops).
  flush() {
    const events = [];
    if (this.open) this.close(this.open.hops.length, events);
    return events;
  }

  isSpeech(level) {
    const speech = level > Math.max(ABS_THRESHOLD, this.noiseFloor * NOISE_RATIO);
    // Track the noise floor: fall quickly, rise slowly, and never learn from speech.
    if (level < this.noiseFloor) this.noiseFloor = 0.9 * this.noiseFloor + 0.1 * level;
    else if (!speech) this.noiseFloor = 0.995 * this.noiseFloor + 0.005 * level;
    return speech;
  }

  consumeHop(hop, events) {
    const index = this.hopIndex++;
    const speech = this.isSpeech(rms(hop));
    const seg = this.open;

    if (!seg) {
      if (!speech) {
        this.ring.push(hop);
        if (this.ring.length > PREROLL_HOPS) this.ring.shift();
        return;
      }
      this.open = {
        id: this.nextId++,
        startHop: index - this.ring.length,
        hops: [...this.ring, hop],
        speechHops: 1,
        silenceRun: 0,
        hopsSincePartial: 0,
      };
      this.ring = [];
      return;
    }

    seg.hops.push(hop);
    seg.hopsSincePartial++;
    if (speech) {
      seg.speechHops++;
      seg.silenceRun = 0;
    } else {
      seg.silenceRun++;
    }

    if (seg.silenceRun >= SILENCE_CLOSE_HOPS) {
      // Keep a little trailing silence, return the rest to the pre-roll ring.
      const keep = seg.hops.length - seg.silenceRun + PREROLL_HOPS;
      this.close(keep, events);
      return;
    }
    if (seg.hops.length >= MAX_SEGMENT_HOPS) {
      this.close(seg.hops.length, events);
      return;
    }
    if (seg.hopsSincePartial >= PARTIAL_EVERY_HOPS && seg.speechHops >= MIN_SPEECH_HOPS) {
      seg.hopsSincePartial = 0;
      events.push(this.event('partial', seg, seg.hops.length));
    }
  }

  close(keepHops, events) {
    const seg = this.open;
    this.open = null;
    this.ring = seg.hops.slice(keepHops).slice(-PREROLL_HOPS);
    if (seg.speechHops < MIN_SPEECH_HOPS) return;
    events.push(this.event('final', seg, keepHops));
  }

  event(type, seg, hopCount) {
    const hops = seg.hops.slice(0, hopCount);
    return {
      type,
      id: seg.id,
      startSample: seg.startHop * HOP,
      endSample: (seg.startHop + hops.length) * HOP,
      samples: concat(hops),
    };
  }
}
