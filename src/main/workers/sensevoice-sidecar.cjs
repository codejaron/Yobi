const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { accessSync, existsSync, constants } = require('node:fs');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function unwrapMessage(message) {
  if (message && typeof message === 'object' && 'data' in message) {
    return message.data;
  }
  return message;
}

function encodeWavFromPcm16(pcmBuffer, sampleRate) {
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        const message = stderr && stderr.trim() ? stderr.trim() : error.message;
        reject(new Error(message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function cleanupSenseVoiceOutput(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidate = [...lines].reverse().find((line) => line.includes('<|')) || lines[lines.length - 1] || '';
  return candidate.replace(/^\[[^\]]+\]\s*/, '').trim();
}

function assertBackendAvailable(filePath) {
  const normalized = String(filePath || '').trim();
  if (!normalized) {
    throw new Error('SenseVoice 本地后端路径为空。');
  }

  if (!existsSync(normalized)) {
    throw new Error(`SenseVoice 本地后端缺失：${normalized}`);
  }

  if (process.platform !== 'win32') {
    try {
      accessSync(normalized, constants.X_OK);
    } catch {
      throw new Error(`SenseVoice 本地后端不可执行：${normalized}`);
    }
  }
}

function assertModelAvailable(filePath) {
  const normalized = String(filePath || '').trim();
  if (!normalized) {
    throw new Error('SenseVoice 模型路径为空。');
  }

  if (!existsSync(normalized)) {
    throw new Error(`SenseVoice 模型文件缺失：${normalized}`);
  }
}

function currentHealth() {
  try {
    assertBackendAvailable(state.backendPath);
    assertModelAvailable(state.modelPath);
    return {
      ready: true,
      message: 'ready'
    };
  } catch (error) {
    return {
      ready: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

const state = {
  backendPath: '',
  modelPath: '',
  streams: new Map()
};

async function runTranscription(pcm16Base64, sampleRate) {
  assertBackendAvailable(state.backendPath);
  assertModelAvailable(state.modelPath);

  const pcm = Buffer.from(String(pcm16Base64 || ''), 'base64');
  if (!pcm.length) {
    return { rawText: '' };
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'yobi-sensevoice-'));
  const wavPath = path.join(tempDir, 'input.wav');

    try {
      await writeFile(wavPath, encodeWavFromPcm16(pcm, Number.isFinite(sampleRate) ? Number(sampleRate) : 16000));
      const { stdout } = await execFileAsync(state.backendPath, [
        '-m',
        state.modelPath,
      '-f',
        wavPath,
        '-l',
        'auto'
      ], {
        cwd: tempDir
      });
    return {
      rawText: cleanupSenseVoiceOutput(stdout)
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function handleMessage(payload) {
  switch (payload.type) {
    case 'load-model':
      state.backendPath = String(payload.backendPath || '').trim();
      state.modelPath = String(payload.modelPath || '').trim();
      assertBackendAvailable(state.backendPath);
      assertModelAvailable(state.modelPath);
      return { ok: true };
    case 'health':
      return currentHealth();
    case 'transcribe':
      return runTranscription(payload.pcm16Base64, payload.sampleRate);
    case 'stream-open': {
      const streamId = randomUUID();
      state.streams.set(streamId, {
        sampleRate: Number.isFinite(payload.sampleRate) ? Number(payload.sampleRate) : 16000,
        chunks: []
      });
      return { streamId };
    }
    case 'stream-chunk': {
      const stream = state.streams.get(String(payload.streamId || ''));
      if (!stream) {
        throw new Error('sensevoice-stream-not-found');
      }
      const chunk = Buffer.from(String(payload.pcm16Base64 || ''), 'base64');
      if (chunk.length) {
        stream.chunks.push(chunk);
      }
      return { accepted: true };
    }
    case 'stream-flush': {
      const stream = state.streams.get(String(payload.streamId || ''));
      if (!stream) {
        throw new Error('sensevoice-stream-not-found');
      }
      return runTranscription(Buffer.concat(stream.chunks).toString('base64'), stream.sampleRate);
    }
    case 'stream-close': {
      const streamId = String(payload.streamId || '');
      const stream = state.streams.get(streamId);
      if (!stream) {
        throw new Error('sensevoice-stream-not-found');
      }
      state.streams.delete(streamId);
      return runTranscription(Buffer.concat(stream.chunks).toString('base64'), stream.sampleRate);
    }
    case 'stream-abort':
      state.streams.delete(String(payload.streamId || ''));
      return { accepted: true };
    default:
      throw new Error(`unknown-sensevoice-message:${String(payload.type || '')}`);
  }
}

process.parentPort.on('message', async (message) => {
  const payload = unwrapMessage(message);
  const id = String(payload && payload.id ? payload.id : '');

  try {
    const result = await handleMessage(payload || {});
    process.parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    process.parentPort.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
