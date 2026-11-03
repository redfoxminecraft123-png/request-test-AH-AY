'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;

  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseIds(raw) {
  const ids = String(raw)
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) throw new Error('TEACHER_IDS must contain at least one numeric id');
  return [...new Set(ids)];
}

function loadConfig() {
  const runtimeDir = path.resolve(env('RUNTIME_DIR', path.join(ROOT, '.runtime')));
  const mode =
    process.argv.includes('--pair') || env('MODE').toLowerCase() === 'pair' ? 'pair' : 'check';

  return {
    mode,
    forceSend: env('FORCE_SEND') === '1',
    root: ROOT,
    runtimeDir,
    stateFile: path.join(runtimeDir, 'state.json'),
    authDir: path.join(runtimeDir, 'wwebjs-auth'),
    api: {
      baseUrl: env('API_BASE_URL', 'https://saas.crazyidea.online').replace(/\/+$/, ''),
      authorization: env('API_AUTHORIZATION'),
      apiKey: env('API_KEY'),
      teacherIds: parseIds(env('TEACHER_IDS', '231,236')),
      timeoutMs: positiveInt('API_TIMEOUT_MS', 45_000),
      retries: positiveInt('API_RETRIES', 4),
    },
    whatsapp: {
      groupName: env('WHATSAPP_GROUP_NAME', 'TTTTT'),
      groupId: env('WHATSAPP_GROUP_ID'),
      phoneNumber: env('WHATSAPP_PHONE_NUMBER').replace(/[^\d]/g, ''),
      pairTimeoutMs: positiveInt('WHATSAPP_PAIR_TIMEOUT_MS', 10 * 60_000),
      readyTimeoutMs: positiveInt('WHATSAPP_READY_TIMEOUT_MS', 2 * 60_000),
      chunkSize: positiveInt('WHATSAPP_CHUNK_SIZE', 50_000),
    },
    archive: {
      key: env('BOT_STATE_KEY'),
      localPath: env('BOT_STATE_LOCAL_ARCHIVE'),
      releaseTag: env('BOT_STATE_RELEASE_TAG', 'bot-state'),
      assetName: 'bot-state.tar.gz.enc',
    },
  };
}

module.exports = { loadConfig };
