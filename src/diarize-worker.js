// Worker thread for diarize.js: loads sherpa-onnx, separates speakers in one
// PCM file and posts { segments } or { error } back. Runs off the main thread
// because process() is synchronous and takes minutes for a long call.
const { parentPort, workerData } = require('node:worker_threads');
const { readPcmFloat32 } = require('./diarize');

try {
  const sherpa = require('sherpa-onnx-node');
  const samples = readPcmFloat32(workerData.pcmFile);
  const sd = new sherpa.OfflineSpeakerDiarization(workerData.config);
  const segments = sd.process(samples).map(({ start, end, speaker }) => ({ start, end, speaker }));
  parentPort.postMessage({ segments });
} catch (err) {
  parentPort.postMessage({ error: err.message || String(err) });
}
