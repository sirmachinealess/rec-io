// Captures one MediaStream as 16 kHz Int16 PCM frames.
export async function startPcmCapture(stream, onFrame) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
  const node = new AudioWorkletNode(ctx, 'pcm');
  node.port.onmessage = (event) => onFrame(event.data);
  ctx.createMediaStreamSource(stream).connect(node);
  return async () => {
    stream.getTracks().forEach((t) => t.stop());
    node.port.onmessage = null;
    await ctx.close();
  };
}

export function getMicrophone() {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });
}

// Main process answers this with WASAPI loopback (everything you hear).
export async function getSystemAudio() {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  stream.getVideoTracks().forEach((t) => t.stop());
  if (stream.getAudioTracks().length === 0) throw new Error('No loopback audio track was returned');
  return new MediaStream(stream.getAudioTracks());
}
