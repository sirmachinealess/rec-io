// The optional speaker-separation models (sherpa-onnx), downloaded once into
// %APPDATA%\rec.io\speakers by "Set up speaker separation". Every file is
// SHA-256-verified; the licence texts are installed next to the models.
//   segmentation: pyannote segmentation-3.0, ONNX export by sherpa-onnx (MIT)
//   embedding:    3D-Speaker speaker-embedding model (Apache-2.0)
const fs = require('node:fs');
const path = require('node:path');
const { downloadFile, sha256File } = require('./download');

const PACK_VERSION = 1;
const SEGMENTATION_HF = 'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/9403a6902bb58e3d5ae8c7e77c3422de279db2e0';
const EMBEDDING_RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models';
const LICENSE_3D_SPEAKER = 'https://raw.githubusercontent.com/modelscope/3D-Speaker/065629c313eaf1a01c65c640c46d77e61e9607b4/LICENSE';

// Both embedding candidates; EMBEDDING picks the one that is installed.
const EMBEDDINGS = {
  campplus: {
    file: '3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx',
    sha256: '98daf9bcf1c8abf3db374fec4c27a5eda7c58705bb3f180d057b085a72a88bb5',
    bytes: 29_596_979,
  },
  eres2net: {
    file: '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx',
    sha256: 'f1ee61be04000b50392a63442e5dd9feaea7e81dddd494d3647cf1c3d88a1498',
    bytes: 39_593_762,
  },
};
const EMBEDDING = 'campplus';

const ASSETS = [
  {
    target: 'segmentation.onnx',
    url: `${SEGMENTATION_HF}/model.onnx`,
    sha256: '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079',
    bytes: 5_992_913,
  },
  {
    target: 'licenses/pyannote-segmentation-3.0-MIT.txt',
    url: `${SEGMENTATION_HF}/LICENSE`,
    sha256: '14d7016ad68e7394d6e6b78d96cc2ae431c905287b89674cfdf021e79e62b8ba',
    bytes: 1_061,
  },
  {
    target: 'embedding.onnx',
    url: `${EMBEDDING_RELEASE}/${EMBEDDINGS[EMBEDDING].file}`,
    sha256: EMBEDDINGS[EMBEDDING].sha256,
    bytes: EMBEDDINGS[EMBEDDING].bytes,
  },
  {
    target: 'licenses/3D-Speaker-Apache-2.0.txt',
    url: LICENSE_3D_SPEAKER,
    sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
    bytes: 11_357,
  },
];
const TOTAL_BYTES = ASSETS.reduce((sum, a) => sum + a.bytes, 0);

class SpeakerPack {
  constructor(root) {
    this.root = root;
    this.marker = path.join(root, 'installed.json');
  }

  get segmentationPath() { return path.join(this.root, 'segmentation.onnx'); }
  get embeddingPath() { return path.join(this.root, 'embedding.onnx'); }
  get downloadMb() { return Math.round(TOTAL_BYTES / 1e6); }

  isInstalled() {
    try {
      const marker = JSON.parse(fs.readFileSync(this.marker, 'utf8'));
      return marker.version === PACK_VERSION && marker.embedding === EMBEDDING
        && fs.existsSync(this.segmentationPath) && fs.existsSync(this.embeddingPath);
    } catch {
      return false;
    }
  }

  // onProgress({ pct, label }). Files go to ./staging first and replace the
  // installed set only once all of them are verified.
  async install(onProgress, { download = downloadFile } = {}) {
    const staging = path.join(this.root, 'staging');
    fs.rmSync(staging, { recursive: true, force: true });
    let doneBefore = 0;
    for (const asset of ASSETS) {
      const file = path.join(staging, asset.target);
      const name = path.basename(new URL(asset.url).pathname);
      const report = (done) => onProgress({ pct: Math.min(99, Math.floor(((doneBefore + done) / TOTAL_BYTES) * 100)), label: `Downloading ${name}` });
      await download(asset.url, file, { sha256: asset.sha256, onProgress: report });
      if ((await sha256File(file)) !== asset.sha256) throw new Error(`Checksum mismatch for ${name}`);
      doneBefore += asset.bytes;
    }
    for (const entry of ['segmentation.onnx', 'embedding.onnx', 'licenses']) {
      fs.rmSync(path.join(this.root, entry), { recursive: true, force: true });
      fs.renameSync(path.join(staging, entry), path.join(this.root, entry));
    }
    fs.rmSync(staging, { recursive: true, force: true });
    fs.writeFileSync(this.marker, JSON.stringify({ version: PACK_VERSION, embedding: EMBEDDING, installedAt: new Date().toISOString() }));
    onProgress({ pct: 100, label: 'Speaker separation is ready' });
  }
}

module.exports = { SpeakerPack, ASSETS, EMBEDDINGS, EMBEDDING };
