// Transcript chunk store. Merge rule:
// a chunk with a known id replaces the old one (a partial being revised);
// a new id is inserted in start-time order. An empty final removes the chunk.
export class TranscriptStore {
  constructor() {
    this.chunks = [];
  }

  upsert(chunk) {
    const i = this.chunks.findIndex((c) => c.id === chunk.id);
    if (chunk.isFinal && !chunk.text) {
      if (i >= 0) this.chunks.splice(i, 1);
      return this.chunks;
    }
    if (i >= 0) {
      this.chunks[i] = chunk;
    } else {
      let at = this.chunks.length;
      while (at > 0 && this.chunks[at - 1].startMs > chunk.startMs) at--;
      this.chunks.splice(at, 0, chunk);
    }
    return this.chunks;
  }

  toMarkdown(title, labels) {
    const lines = this.chunks
      .filter((c) => c.isFinal)
      .map((c) => `**${labels[c.source]}** [${formatTime(c.startMs)}]: ${c.text}`);
    return `# ${title}\n\n${lines.join('\n\n')}\n`;
  }
}

export function formatTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
