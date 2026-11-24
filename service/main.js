// SenseVoice STT extension service.
//
// Runs under the OpenChamber host runtime (ELECTRON_RUN_AS_NODE=1) on loopback.
// It exposes two listeners:
//
//   1. OPENCHAMBER_SERVICE_PORT — the host's private proxy port. Every request
//      needs `Authorization: Bearer <OPENCHAMBER_SERVICE_TOKEN>`; GET /health is
//      the readiness signal.
//   2. A fixed loopback port (47831 by default) — an OpenAI-compatible
//      `/audio/transcriptions` endpoint that OpenChamber's "server" STT mode
//      calls. It has no bearer auth because the core STT client does not know
//      the extension token; it only listens on 127.0.0.1.
//
// The model and runtime are taken from cc-haha on first use and materialised in
// OPENCHAMBER_SERVICE_DATA_DIR: the .onnx/.txt files as hardlinks when the data
// dir is on the same volume (zero extra bytes), the ~23 MB sherpa runtime as a
// one-time copy. After that the service is independent of the cc-haha process,
// and runs fine while cc-haha is closed or even after it is uninstalled.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const SERVICE_NAME = 'sensevoice-stt';
const SAMPLE_RATE = 16000;
const DEFAULT_STT_PORT = 47831;
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const TARGET_PEAK = 0.6;
const MAX_GAIN = 50;
const DEFAULT_IDLE_UNLOAD_MS = 5 * 60 * 1000;

const HOST_PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';

const DATA_DIR = process.env.OPENCHAMBER_SERVICE_DATA_DIR?.trim()
  || path.join(os.homedir(), '.config', 'openchamber', 'guest-data', SERVICE_NAME);

function resolveDataDir() {
  return path.resolve(DATA_DIR);
}

function readConfigFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(resolveDataDir(), 'config.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const CONFIG = readConfigFile();

const IDLE_UNLOAD_MS = (() => {
  const fromEnv = Number(process.env.SENSEVOICE_IDLE_UNLOAD_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  const fromConfig = Number(CONFIG.idleUnloadMs);
  return Number.isFinite(fromConfig) && fromConfig >= 0 ? fromConfig : DEFAULT_IDLE_UNLOAD_MS;
})();

const NUM_THREADS = (() => {
  const fromEnv = Number(process.env.SENSEVOICE_THREADS);
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv <= 16) return fromEnv;
  const fromConfig = Number(CONFIG.threads);
  return Number.isInteger(fromConfig) && fromConfig > 0 && fromConfig <= 16 ? fromConfig : 2;
})();

const log = (...args) => console.log(`[${SERVICE_NAME}]`, ...args);
const logError = (...args) => console.error(`[${SERVICE_NAME}]`, ...args);

// ---------------------------------------------------------------- paths

function resolveCcHahaVoiceDir() {
  const override = process.env.SENSEVOICE_CC_HAHA_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.claude', 'cc-haha', 'voice', 'sensevoice');
}

function resolveSourceModelDir() {
  const fromEnv = process.env.SENSEVOICE_MODEL_DIR?.trim();
  const fromConfig = typeof CONFIG.modelDir === 'string' ? CONFIG.modelDir.trim() : '';
  const override = fromEnv || fromConfig;
  if (override) return path.resolve(override);
  return path.join(resolveCcHahaVoiceDir(), 'models');
}

function resolveLanguage() {
  const raw = process.env.SENSEVOICE_LANGUAGE ?? CONFIG.language ?? 'auto';
  return String(raw).trim() || 'auto';
}

const MODEL_CANDIDATES = ['model.int8.onnx', 'model.onnx'];

function pickSourceModel(modelDir) {
  for (const name of MODEL_CANDIDATES) {
    const filePath = path.join(modelDir, name);
    if (fs.existsSync(filePath)) return { name, path: filePath };
  }
  throw new Error(
    `SenseVoice model not found in ${modelDir} (looked for ${MODEL_CANDIDATES.join(', ')}). ` +
    'Set SENSEVOICE_MODEL_DIR to the folder that contains model.int8.onnx and tokens.txt.',
  );
}

function platformPackageName() {
  const platform = process.platform === 'win32' ? 'win' : process.platform;
  return `sherpa-onnx-${platform}-${process.arch}`;
}

function compareVersionsDesc(a, b) {
  const left = a.split('.').map((part) => Number(part) || 0);
  const right = b.split('.').map((part) => Number(part) || 0);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function runtimeSourceCandidates() {
  const candidates = [];
  const fromEnv = process.env.SENSEVOICE_SHERPA_RUNTIME?.trim();
  const fromConfig = typeof CONFIG.sherpaRuntime === 'string' ? CONFIG.sherpaRuntime.trim() : '';
  const explicit = fromEnv || fromConfig;
  if (explicit) {
    candidates.push(path.resolve(explicit));
  }
  const runtimeRoot = path.join(resolveCcHahaVoiceDir(), 'runtime');
  let versions = [];
  try {
    versions = fs.readdirSync(runtimeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => /^\d+(?:\.\d+)*$/.test(name))
      .sort(compareVersionsDesc);
  } catch {
    versions = [];
  }
  for (const version of versions) {
    candidates.push(path.join(runtimeRoot, version, 'node_modules'));
  }
  return candidates;
}

function isValidRuntimeDir(nodeModulesDir) {
  try {
    const wrapper = path.join(nodeModulesDir, 'sherpa-onnx-node', 'sherpa-onnx.js');
    const addon = path.join(nodeModulesDir, platformPackageName(), 'sherpa-onnx.node');
    return fs.statSync(wrapper).isFile() && fs.statSync(addon).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- assets

let assetsPromise = null;

async function linkOrCopy(source, target) {
  const sourceStat = await fsp.stat(source).catch(() => null);
  if (!sourceStat || !sourceStat.isFile()) {
    throw new Error(`Missing model file: ${source}`);
  }
  try {
    const targetStat = await fsp.stat(target);
    if (targetStat.isFile() && targetStat.size === sourceStat.size) {
      return { path: target, mode: 'existing' };
    }
    await fsp.rm(target, { force: true });
  } catch {
    // target does not exist yet
  }
  try {
    await fsp.link(source, target);
    return { path: target, mode: 'hardlink' };
  } catch (error) {
    log(`hardlink failed for ${path.basename(source)} (${error?.code ?? error}); copying instead`);
  }
  const temporary = `${target}.${process.pid}.tmp`;
  await fsp.copyFile(source, temporary);
  await fsp.rename(temporary, target);
  return { path: target, mode: 'copy' };
}

async function ensureRuntime() {
  const targetRoot = path.join(resolveDataDir(), 'sherpa');
  if (isValidRuntimeDir(targetRoot)) {
    return { dir: targetRoot, mode: 'existing' };
  }
  const source = runtimeSourceCandidates().find(isValidRuntimeDir);
  if (!source) {
    throw new Error(
      'sherpa-onnx runtime not found. Expected a cc-haha runtime under ' +
      `${path.join(resolveCcHahaVoiceDir(), 'runtime')} or a path in SENSEVOICE_SHERPA_RUNTIME.`,
    );
  }
  await fsp.mkdir(targetRoot, { recursive: true });
  const addonName = platformPackageName();
  const targetNode = path.join(targetRoot, 'sherpa-onnx-node');
  const targetAddon = path.join(targetRoot, addonName);
  const temporaryNode = `${targetNode}.${process.pid}.tmp`;
  const temporaryAddon = `${targetAddon}.${process.pid}.tmp`;
  log(`copying sherpa runtime from ${source} ...`);
  await fsp.rm(temporaryNode, { recursive: true, force: true });
  await fsp.rm(temporaryAddon, { recursive: true, force: true });
  await fsp.cp(path.join(source, 'sherpa-onnx-node'), temporaryNode, { recursive: true });
  await fsp.cp(path.join(source, addonName), temporaryAddon, { recursive: true });
  await fsp.rm(targetNode, { recursive: true, force: true });
  await fsp.rm(targetAddon, { recursive: true, force: true });
  await fsp.rename(temporaryNode, targetNode);
  await fsp.rename(temporaryAddon, targetAddon);
  if (!isValidRuntimeDir(targetRoot)) {
    throw new Error('Copied sherpa runtime is incomplete');
  }
  return { dir: targetRoot, mode: 'copy' };
}

async function ensureAssets() {
  if (assetsPromise) return assetsPromise;
  assetsPromise = (async () => {
    const dataDir = resolveDataDir();
    await fsp.mkdir(dataDir, { recursive: true });
    const modelsDir = path.join(dataDir, 'models');
    await fsp.mkdir(modelsDir, { recursive: true });

    const sourceDir = resolveSourceModelDir();
    const sourceModel = pickSourceModel(sourceDir);
    const sourceTokens = path.join(sourceDir, 'tokens.txt');
    if (!fs.existsSync(sourceTokens)) {
      throw new Error(`Missing tokens file: ${sourceTokens}`);
    }

    const model = await linkOrCopy(sourceModel.path, path.join(modelsDir, sourceModel.name));
    const tokens = await linkOrCopy(sourceTokens, path.join(modelsDir, 'tokens.txt'));
    const runtime = await ensureRuntime();
    const info = {
      dataDir,
      model: model.path,
      modelMode: model.mode,
      modelSource: sourceModel.path,
      tokens: tokens.path,
      tokensMode: tokens.mode,
      runtimeDir: runtime.dir,
      runtimeMode: runtime.mode,
    };
    log(
      `assets ready: model=${path.basename(info.model)} (${info.modelMode}), ` +
      `runtime=${info.runtimeDir} (${info.runtimeMode})`,
    );
    return info;
  })().catch((error) => {
    assetsPromise = null;
    throw error;
  });
  return assetsPromise;
}

// ---------------------------------------------------------------- engine

let engine = null;
let enginePromise = null;
let engineInfo = null;
let engineLoadedAt = 0;
let lastUsedAt = 0;

async function getEngine() {
  if (engine) return engine;
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const assets = await ensureAssets();
    const wrapper = path.join(assets.runtimeDir, 'sherpa-onnx-node', 'sherpa-onnx.js');
    const sherpa = require(wrapper);
    if (typeof sherpa.OfflineRecognizer !== 'function') {
      throw new Error('sherpa-onnx-node loaded, but OfflineRecognizer is missing');
    }
    const startedAt = Date.now();
    const recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        senseVoice: {
          model: assets.model,
          language: resolveLanguage(),
          useInverseTextNormalization: 1,
          numThreads: NUM_THREADS,
          provider: 'cpu',
          debug: 0,
        },
        tokens: assets.tokens,
        numThreads: NUM_THREADS,
        provider: 'cpu',
        debug: 0,
        modelType: 'sense_voice',
      },
      decodingMethod: 'greedy_search',
      maxActivePaths: 4,
    });
    engine = recognizer;
    engineLoadedAt = Date.now();
    engineInfo = {
      ...assets,
      language: resolveLanguage(),
      numThreads: NUM_THREADS,
      loadMs: engineLoadedAt - startedAt,
    };
    log(`recognizer ready in ${engineInfo.loadMs} ms (rss ${rssMb()} MB)`);
    return engine;
  })().finally(() => {
    enginePromise = null;
  });
  return enginePromise;
}

function unloadEngine(reason) {
  if (!engine) return;
  const old = engine;
  engine = null;
  try {
    old.free?.();
  } catch (error) {
    logError(`failed to free recognizer: ${error?.message ?? error}`);
  }
  log(`recognizer unloaded (${reason}, rss ${rssMb()} MB)`);
}

function rssMb() {
  return Math.round(process.memoryUsage().rss / 1048576);
}

// ---------------------------------------------------------------- audio

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parseWav(buffer) {
  if (buffer.length < 12) {
    throw httpError(400, 'Audio payload is too small to be a WAV file');
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw httpError(400, 'Only RIFF/WAVE audio is supported');
  }
  let fmt = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = Math.min(buffer.length, bodyStart + size);
    if (id === 'fmt ' && size >= 16) {
      let audioFormat = buffer.readUInt16LE(bodyStart);
      const channels = buffer.readUInt16LE(bodyStart + 2);
      const sampleRate = buffer.readUInt32LE(bodyStart + 4);
      const bitsPerSample = buffer.readUInt16LE(bodyStart + 14);
      if (audioFormat === 0xfffe && size >= 26) {
        audioFormat = buffer.readUInt16LE(bodyStart + 24);
      }
      fmt = { audioFormat, channels, sampleRate, bitsPerSample };
    } else if (id === 'data') {
      data = buffer.subarray(bodyStart, bodyEnd);
    }
    offset = bodyEnd + (size & 1);
  }
  if (!fmt) throw httpError(400, 'WAV file has no fmt chunk');
  if (!data || data.length === 0) throw httpError(400, 'WAV file has no audio data');
  return { fmt, data };
}

function resampleLinear(input, inputRate, outputRate) {
  const ratio = inputRate / outputRate;
  const length = Math.max(0, Math.floor(input.length / ratio));
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const first = input[index] ?? 0;
    const second = input[index + 1] ?? first;
    output[i] = first + (second - first) * fraction;
  }
  return output;
}

function applyGain(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] < 0 ? -samples[i] : samples[i];
    if (value > peak) peak = value;
  }
  if (!(peak > 0) || peak >= TARGET_PEAK) return;
  const gain = Math.min(MAX_GAIN, TARGET_PEAK / peak);
  if (!(gain > 1)) return;
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.max(-1, Math.min(1, samples[i] * gain));
  }
}

function wavToFloatSamples(buffer) {
  const { fmt, data } = parseWav(buffer);
  const { audioFormat, channels, sampleRate, bitsPerSample } = fmt;
  if (!Number.isInteger(channels) || channels < 1 || channels > 8) {
    throw httpError(400, `Unsupported channel count: ${channels}`);
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw httpError(400, `Unsupported sample rate: ${sampleRate}`);
  }
  const bytesPerSample = bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample <= 0) {
    throw httpError(400, `Unsupported bits per sample: ${bitsPerSample}`);
  }
  if (!((audioFormat === 1 && bitsPerSample === 16) || (audioFormat === 3 && bitsPerSample === 32))) {
    throw httpError(400, `Unsupported WAV encoding: format=${audioFormat} bits=${bitsPerSample}`);
  }
  const frameBytes = bytesPerSample * channels;
  const frames = Math.floor(data.length / frameBytes);
  if (frames === 0) return new Float32Array(0);

  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const at = frame * frameBytes + channel * bytesPerSample;
      if (audioFormat === 1) {
        sum += data.readInt16LE(at) / 32768;
      } else {
        sum += data.readFloatLE(at);
      }
    }
    mono[frame] = Math.max(-1, Math.min(1, sum / channels));
  }

  const samples = sampleRate === SAMPLE_RATE
    ? mono
    : resampleLinear(mono, sampleRate, SAMPLE_RATE);
  applyGain(samples);
  return samples;
}

// ---------------------------------------------------------------- multipart

function parsePartHeaders(rawHeaders) {
  const headers = {};
  for (const line of rawHeaders.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  const disposition = headers['content-disposition'] ?? '';
  const name = /(?:^|;)\s*name="([^"]*)"/i.exec(disposition)?.[1]
    ?? /(?:^|;)\s*name=([^;]+)/i.exec(disposition)?.[1]
    ?? '';
  const filename = /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition)?.[1]
    ?? /(?:^|;)\s*filename=([^;]+)/i.exec(disposition)?.[1]
    ?? '';
  return {
    name: name.trim(),
    filename: filename.trim(),
    contentType: headers['content-type'] ?? '',
  };
}

function parseMultipart(body, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? '').trim();
  if (!boundary) throw httpError(400, 'multipart boundary is missing');
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = body.indexOf(delimiter);
  if (cursor === -1) throw httpError(400, 'multipart body has no boundary');
  cursor += delimiter.length;
  while (cursor < body.length) {
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) break;
    if (body[cursor] === 0x0d && body[cursor + 1] === 0x0a) cursor += 2;
    const headerEnd = body.indexOf('\r\n\r\n', cursor);
    if (headerEnd === -1) break;
    const headers = parsePartHeaders(body.toString('utf8', cursor, headerEnd));
    const contentStart = headerEnd + 4;
    const nextDelimiter = body.indexOf(Buffer.from(`\r\n--${boundary}`), contentStart);
    const contentEnd = nextDelimiter === -1 ? body.length : nextDelimiter;
    parts.push({ ...headers, data: body.subarray(contentStart, contentEnd) });
    if (nextDelimiter === -1) break;
    cursor = nextDelimiter + 2 + delimiter.length;
  }
  return parts;
}

// ---------------------------------------------------------------- service

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError(413, `Request body is larger than ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks, size)));
    req.on('error', (error) => reject(error));
  });
}

async function transcribeWav(wavBuffer) {
  const startedAt = Date.now();
  const samples = wavToFloatSamples(wavBuffer);
  if (samples.length === 0) {
    return { text: '', audioSeconds: 0, inferenceMs: 0 };
  }
  const recognizer = await getEngine();
  const stream = recognizer.createStream();
  try {
    stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    const text = typeof result?.text === 'string'
      ? result.text.trim()
      : String(result ?? '').trim();
    lastUsedAt = Date.now();
    return {
      text,
      audioSeconds: samples.length / SAMPLE_RATE,
      inferenceMs: Date.now() - startedAt,
    };
  } finally {
    try {
      stream.free?.();
    } catch {
      // ignore
    }
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function statusPayload() {
  return {
    ok: true,
    service: SERVICE_NAME,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    rssMb: rssMb(),
    dataDir: resolveDataDir(),
    sttPort,
    sttError,
    modelLoaded: Boolean(engine),
    engineInfo,
    lastUsedAt: lastUsedAt || null,
    idleUnloadMs: IDLE_UNLOAD_MS,
  };
}

async function handleHost(req, res, url) {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    sendJson(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }
  if (url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: SERVICE_NAME,
      pid: process.pid,
      modelLoaded: Boolean(engine),
      sttPort,
      sttError,
    });
    return;
  }
  if (url.pathname === '/status') {
    sendJson(res, 200, statusPayload());
    return;
  }
  sendJson(res, 404, { ok: false, error: 'not-found' });
}

async function handleStt(req, res, url) {
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    sendJson(res, 200, {
      ok: true,
      service: SERVICE_NAME,
      modelLoaded: Boolean(engine),
      sttError,
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/status') {
    sendJson(res, 200, statusPayload());
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    sendJson(res, 200, {
      object: 'list',
      data: [{ id: 'sensevoice', object: 'model', created: 0, owned_by: 'local' }],
    });
    return;
  }
  if (
    req.method === 'POST'
    && (url.pathname === '/audio/transcriptions'
      || url.pathname === '/v1/audio/transcriptions'
      || url.pathname === '/transcribe')
  ) {
    const body = await readBody(req, MAX_UPLOAD_BYTES);
    const contentType = String(req.headers['content-type'] ?? '');
    let audio = null;
    let fields = {};
    if (/^multipart\/form-data/i.test(contentType)) {
      const parts = parseMultipart(body, contentType);
      for (const part of parts) {
        if (part.name === 'file' && part.data.length > 0) {
          audio = part.data;
        } else if (part.name) {
          fields[part.name] = part.data.toString('utf8');
        }
      }
      if (!audio) throw httpError(400, 'multipart body has no "file" part');
    } else {
      audio = body;
    }
    if (!audio || audio.length === 0) throw httpError(400, 'Request body is empty');

    const result = await transcribeWav(audio);
    log(
      `transcribed ${result.audioSeconds.toFixed(2)}s audio in ${result.inferenceMs} ms ` +
      `(rss ${rssMb()} MB)`,
    );
    const responseFormat = String(fields.response_format || url.searchParams.get('response_format') || 'json');
    if (responseFormat === 'text') {
      sendText(res, 200, result.text);
      return;
    }
    if (responseFormat === 'verbose_json') {
      sendJson(res, 200, {
        task: 'transcribe',
        language: fields.language || 'auto',
        duration: result.audioSeconds,
        text: result.text,
        segments: [],
      });
      return;
    }
    sendJson(res, 200, { text: result.text });
    return;
  }
  sendJson(res, 404, { error: { message: 'not-found', type: 'invalid_request_error' } });
}

function createServer(kind, handler) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    Promise.resolve(handler(req, res, url)).catch((error) => {
      const status = Number(error?.statusCode) || 500;
      const message = String(error?.message ?? error);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (kind === 'host') {
        sendJson(res, status, { ok: false, error: message });
      } else {
        sendJson(res, status, {
          error: {
            message,
            type: status === 400 || status === 413 ? 'invalid_request_error' : 'server_error',
          },
        });
      }
    });
  });
}

// ---------------------------------------------------------------- main

function readSttPort() {
  const fromEnv = Number(process.env.SENSEVOICE_STT_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv <= 65535) return fromEnv;
  const fromConfig = Number(CONFIG.port);
  if (Number.isInteger(fromConfig) && fromConfig > 0 && fromConfig <= 65535) return fromConfig;
  return DEFAULT_STT_PORT;
}

if (!Number.isInteger(HOST_PORT) || HOST_PORT <= 0 || HOST_PORT > 65535 || !TOKEN) {
  logError('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const sttPort = readSttPort();
let sttError = null;

const hostServer = createServer('host', handleHost);
const sttServer = createServer('stt', handleStt);

hostServer.on('error', (error) => {
  logError(`host listener failed on 127.0.0.1:${HOST_PORT}: ${error?.message ?? error}`);
  process.exit(1);
});
sttServer.on('error', (error) => {
  sttError = String(error?.message ?? error);
  logError(`STT listener failed on 127.0.0.1:${sttPort}: ${sttError}`);
});

hostServer.listen(HOST_PORT, '127.0.0.1', () => {
  log(`host listener ready on 127.0.0.1:${HOST_PORT}`);
});

sttServer.listen(sttPort, '127.0.0.1', () => {
  log(`OpenAI-compatible STT ready on http://127.0.0.1:${sttPort} (endpoint /audio/transcriptions or /v1/audio/transcriptions)`);
  log(`data dir: ${resolveDataDir()}`);
  log(`model source: ${resolveSourceModelDir()}`);
});

const idleTimer = setInterval(() => {
  if (!engine) return;
  const since = Math.max(lastUsedAt || 0, engineLoadedAt || 0);
  if (Date.now() - since < IDLE_UNLOAD_MS) return;
  unloadEngine(`idle for ${Math.round(IDLE_UNLOAD_MS / 1000)}s`);
}, 60_000);
idleTimer.unref?.();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${signal})`);
  idleTimer && clearInterval(idleTimer);
  unloadEngine('shutdown');
  hostServer.close();
  sttServer.close();
  const forced = setTimeout(() => process.exit(0), 2000);
  forced.unref?.();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
