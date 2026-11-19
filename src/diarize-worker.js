// Worker thread for diarize.js: loads sherpa-onnx, separates speakers in one
// PCM file, runs the merge pass (speaker-merge.js) and posts { turns } (times
// relative to the file) or { error } back. Runs off the main thread because the
// engine is synchronous and takes minutes for a long call.
const { parentPort, workerData } = require('node:worker_threads');
const { readPcmFloat32, toTurns } = require('./diarize');
const { mergeSpeakers } = require('./speaker-merge');

try {
  const sherpa = require('sherpa-onnx-node');
  const { pcmFile, config, merge } = workerData;
  const samples = readPcmFloat32(pcmFile);
  const sd = new sherpa.OfflineSpeakerDiarization(config);
  const turns = toTurns(sd.process(samples));
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: config.embedding.model, numThreads: config.embedding.numThreads });
  const embed = (audio) => {
    const stream = extractor.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples: audio });
    stream.inputFinished();
    // Electron does not allow external buffers: copy the result instead.
    return extractor.compute(stream, false);
  };
  parentPort.postMessage({ turns: mergeSpeakers(turns, samples, embed, merge) });
} catch (err) {
  parentPort.postMessage({ error: err.message || String(err) });
}
