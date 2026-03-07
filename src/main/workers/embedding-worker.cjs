const fs = require('node:fs');
const path = require('node:path');

const HASH_VECTOR_SIZE = 48;
const CONCEPT_VECTOR_SIZE = 16;
const TOTAL_VECTOR_SIZE = HASH_VECTOR_SIZE + CONCEPT_VECTOR_SIZE;

const CONCEPTS = [
  { label: 'fatigue-workload', terms: ['累', '疲惫', '困', '忙', '压力', '加班', '工作多', '工作很满', '撑不住', '上班'] },
  { label: 'sadness', terms: ['难过', '低落', '沮丧', '伤心', '想哭'] },
  { label: 'anxiety', terms: ['焦虑', '担心', '不安', '慌', '紧张'] },
  { label: 'joy', terms: ['开心', '高兴', '快乐', '兴奋', '期待'] },
  { label: 'games', terms: ['原神', '游戏', '米哈游', 'steam', 'switch'] },
  { label: 'study', terms: ['学习', '考试', '作业', '论文', '上课'] },
  { label: 'sleep', terms: ['睡', '失眠', '熬夜', '困', '补觉'] },
  { label: 'food', terms: ['吃', '饭', '火锅', '奶茶', '咖啡'] }
];

let state = {
  backend: 'heuristic',
  status: 'loading',
  message: '',
  modelId: '',
  modelPath: null,
  llamaContext: null
};

function normalize(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenize(text) {
  const normalized = normalize(text);
  const englishTokens = normalized.match(/[a-z0-9_]{2,24}/g) ?? [];
  const cjkChars = [...normalized].filter((char) => /[\u3400-\u9fff]/.test(char));
  const cjkTokens = [];
  for (const gramSize of [2, 3]) {
    if (cjkChars.length < gramSize) continue;
    for (let index = 0; index <= cjkChars.length - gramSize; index += 1) {
      cjkTokens.push(cjkChars.slice(index, index + gramSize).join(''));
    }
  }
  return [...englishTokens, ...cjkTokens];
}

function hashToken(token) {
  let hash = 0;
  for (const char of token) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

function normalizeVector(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm <= 0) return vector;
  return vector.map((value) => value / norm);
}

function heuristicEmbed(text) {
  const vector = new Array(TOTAL_VECTOR_SIZE).fill(0);
  const normalized = normalize(text);
  for (const token of tokenize(normalized)) {
    const bucket = hashToken(token) % HASH_VECTOR_SIZE;
    vector[bucket] += token.length >= 3 ? 0.5 : 0.3;
  }
  CONCEPTS.slice(0, CONCEPT_VECTOR_SIZE).forEach((concept, index) => {
    if (concept.terms.some((term) => normalized.includes(term))) {
      vector[HASH_VECTOR_SIZE + index] += 6;
    }
  });
  return normalizeVector(vector);
}

async function initEmbedder(message) {
  state.modelId = message.modelId || '';
  state.modelPath = message.modelPath || null;
  state.backend = 'heuristic';
  state.status = 'ready';
  state.message = 'heuristic-local-embedder';
  state.llamaContext = null;

  if (!state.modelPath || !fs.existsSync(state.modelPath)) {
    return state;
  }

  try {
    const llamaModule = await import('node-llama-cpp');
    const llama = await llamaModule.getLlama({ progressLogs: false, skipDownload: true });
    const model = await llama.loadModel({ modelPath: state.modelPath, gpuLayers: 0 });
    state.llamaContext = await model.createEmbeddingContext();
    state.backend = 'llama';
    state.status = 'ready';
    state.message = `llama-local-embedder:${path.basename(state.modelPath)}`;
  } catch (error) {
    state.backend = 'heuristic';
    state.status = 'ready';
    state.message = `heuristic fallback: ${error instanceof Error ? error.message : String(error)}`;
    state.llamaContext = null;
  }

  return state;
}

async function embedText(message) {
  const text = normalize(message.text);
  if (!text) return { modelId: state.modelId, vector: [] };

  if (state.backend === 'llama' && state.llamaContext) {
    try {
      const embedding = await state.llamaContext.getEmbeddingFor(text);
      return {
        modelId: state.modelId,
        vector: normalizeVector([...embedding.vector])
      };
    } catch (error) {
      state.backend = 'heuristic';
      state.message = `heuristic fallback: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return {
    modelId: state.modelId,
    vector: heuristicEmbed(text)
  };
}

process.parentPort.on('message', async (message) => {
  const id = message?.id;
  try {
    let result = null;
    if (message?.type === 'init') {
      result = await initEmbedder(message);
    } else if (message?.type === 'embed') {
      result = await embedText(message);
    } else if (message?.type === 'status') {
      result = { ...state };
    } else {
      throw new Error(`unknown-worker-message:${String(message?.type || '')}`);
    }

    process.parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    process.parentPort.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
