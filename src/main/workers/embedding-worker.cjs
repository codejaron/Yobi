const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let state = {
  backend: 'unavailable',
  status: 'loading',
  message: '',
  modelId: '',
  modelPath: null,
  llamaContext: null
};

function unwrapMessage(message) {
  if (message && typeof message === 'object' && 'data' in message) {
    return message.data;
  }
  return message;
}

function snapshotState() {
  return {
    backend: state.backend,
    status: state.status,
    message: state.message,
    modelId: state.modelId,
    modelPath: state.modelPath
  };
}

function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function normalizeVector(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm <= 0) return vector;
  return vector.map((value) => value / norm);
}

async function initEmbedder(message) {
  state.modelId = message.modelId || '';
  state.modelPath = message.modelPath || null;
  state.backend = 'unavailable';
  state.status = 'error';
  state.message = 'vector-unavailable';
  state.llamaContext = null;

  if (!state.modelPath || !fs.existsSync(state.modelPath)) {
    state.message = 'missing-model';
    return snapshotState();
  }

  const moduleUrl = message.nodeLlamaModuleUrl || pathToFileURL(require.resolve('node-llama-cpp/dist/index.js')).href;
  const llamaModule = await import(moduleUrl);
  const llama = await llamaModule.getLlama({
    gpu: message.preferredGpu || 'auto',
    progressLogs: false,
    skipDownload: true,
    logLevel: 'warn'
  });
  const model = await llama.loadModel({ modelPath: state.modelPath, gpuLayers: 0 });
  state.llamaContext = await model.createEmbeddingContext();
  state.backend = 'llama';
  state.status = 'ready';
  state.message = `llama-local-embedder:${path.basename(state.modelPath)}`;
  return snapshotState();
}

async function embedText(message) {
  const text = normalize(message.text);
  if (!text) return { modelId: state.modelId, vector: [] };
  if (state.backend !== 'llama' || !state.llamaContext) {
    throw new Error('embedding-worker-not-ready');
  }

  const embedding = await state.llamaContext.getEmbeddingFor(text);
  return {
    modelId: state.modelId,
    vector: normalizeVector([...embedding.vector])
  };
}

process.parentPort.on('message', async (message) => {
  const payload = unwrapMessage(message);
  const id = payload?.id;
  try {
    let result = null;
    if (payload?.type === 'init') {
      result = await initEmbedder(payload);
    } else if (payload?.type === 'embed') {
      result = await embedText(payload);
    } else if (payload?.type === 'status') {
      result = snapshotState();
    } else {
      throw new Error(`unknown-worker-message:${String(payload?.type || '')}`);
    }

    process.parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    state.backend = 'unavailable';
    state.status = 'error';
    state.message = error instanceof Error ? error.message : String(error);
    process.parentPort.postMessage({
      id,
      ok: false,
      error: state.message
    });
  }
});
