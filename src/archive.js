'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');

const MAGIC = Buffer.from('RQBT1\0', 'binary');
const AAD = Buffer.from('request-bot-state-v1');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SESSION_MARKER = '.session-ok';
const ARCHIVE_ENTRIES = ['state.json', 'wwebjs-auth', 'wwebjs-cache', SESSION_MARKER];

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, KEY_LEN, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

function encryptBuffer(plain, passphrase) {
  if (!passphrase) throw new Error('BOT_STATE_KEY is not set');
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  key.fill(0);
  return Buffer.concat([MAGIC, salt, iv, tag, ciphertext]);
}

function decryptBuffer(payload, passphrase) {
  if (!passphrase) throw new Error('BOT_STATE_KEY is not set');
  if (!Buffer.isBuffer(payload) || payload.length < MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN) {
    throw new Error('Encrypted archive is truncated or empty');
  }

  let offset = 0;
  const magic = payload.subarray(offset, (offset += MAGIC.length));
  if (!magic.equals(MAGIC)) {
    throw new Error('Encrypted archive has an unknown format');
  }
  const salt = payload.subarray(offset, (offset += SALT_LEN));
  const iv = payload.subarray(offset, (offset += IV_LEN));
  const tag = payload.subarray(offset, (offset += TAG_LEN));
  const ciphertext = payload.subarray(offset);

  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  try {
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    key.fill(0);
    return plain;
  } catch {
    key.fill(0);
    throw new Error('Could not decrypt archive: wrong BOT_STATE_KEY or corrupted file');
  }
}

function runTar(args) {
  const result = spawnSync('tar', args, { encoding: 'utf8' });
  if (result.error) {
    throw new Error(`Could not run tar: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `tar exited with ${result.status}: ${String(result.stderr || '').trim().slice(0, 500)}`,
    );
  }
  return result;
}

function archiveEntries(runtimeDir) {
  const hasSession = fs.existsSync(path.join(runtimeDir, SESSION_MARKER));
  return ARCHIVE_ENTRIES.filter((name) => {
    if (!hasSession && (name === 'wwebjs-auth' || name === 'wwebjs-cache')) return false;
    return fs.existsSync(path.join(runtimeDir, name));
  });
}

function packRuntime(runtimeDir, tarPath) {
  const entries = archiveEntries(runtimeDir);
  if (entries.length === 0) return false;
  runTar(['-czf', tarPath, '-C', runtimeDir, ...entries]);
  return true;
}

function assertSafeArchive(tarPath) {
  const result = runTar(['-tzf', tarPath]);
  const entries = String(result.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean);

  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/');
    if (
      normalized.startsWith('/') ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.split('/').includes('..')
    ) {
      throw new Error('Refusing to extract an archive that contains unsafe paths');
    }
  }
}

function unpackRuntime(tarPath, runtimeDir) {
  assertSafeArchive(tarPath);
  fs.mkdirSync(runtimeDir, { recursive: true });
  runTar(['-xzf', tarPath, '-C', runtimeDir]);
}

function detectRepoFromGit() {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = remote.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
    return match ? `${match[1]}/${match[2]}` : '';
  } catch {
    return '';
  }
}

function detectGhToken() {
  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function githubContext() {
  const repo = process.env.GITHUB_REPOSITORY || detectRepoFromGit();
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || detectGhToken();
  if (!repo) {
    throw new Error(
      'GITHUB_REPOSITORY is not set and no GitHub origin remote was found. Set it or add an origin remote.',
    );
  }
  if (!token) {
    throw new Error(
      'No GitHub token found. Set GITHUB_TOKEN/GH_TOKEN or authenticate with "gh auth login".',
    );
  }
  return { repo, token };
}

function githubHeaders(token, extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'request-bot',
    ...extra,
  };
}

async function getRelease(repo, token, tag) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
    { headers: githubHeaders(token) },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status} while reading release ${tag}`);
  }
  return response.json();
}

async function ensureRelease(repo, token, tag) {
  let release = await getRelease(repo, token, tag);
  if (release) return release;

  const response = await fetch(`https://api.github.com/repos/${repo}/releases`, {
    method: 'POST',
    headers: githubHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: process.env.GITHUB_SHA || 'main',
      name: 'Request bot encrypted state',
      body:
        'Encrypted state and WhatsApp session for the request-bot workflow. ' +
        'Contents are AES-256-GCM encrypted with the BOT_STATE_KEY secret. Do not delete.',
      prerelease: true,
      draft: false,
    }),
  });

  if (response.ok) return response.json();
  if (response.status === 422) {
    release = await getRelease(repo, token, tag);
    if (release) return release;
  }
  throw new Error(`GitHub API returned ${response.status} while creating release ${tag}`);
}

async function deleteAsset(repo, token, assetId) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/assets/${assetId}`, {
    method: 'DELETE',
    headers: githubHeaders(token),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`GitHub API returned ${response.status} while deleting the old asset`);
  }
}

async function uploadAsset(repo, token, releaseId, assetName, buffer) {
  const response = await fetch(
    `https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`,
    {
      method: 'POST',
      headers: githubHeaders(token, {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/octet-stream',
      }),
      body: buffer,
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status} while uploading the state archive`);
  }
  return response.json();
}

async function downloadAsset(repo, token, release, assetName) {
  const asset = (release.assets || []).find((item) => item.name === assetName);
  if (!asset) return null;

  const response = await fetch(asset.url, {
    headers: {
      Accept: 'application/octet-stream',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'request-bot',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status} while downloading the state archive`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function resolveLocalPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

async function restoreArchive(config, logger) {
  const { key, localPath, releaseTag, assetName } = config.archive;
  if (!key) {
    throw new Error(
      'BOT_STATE_KEY is not set. It is required to decrypt the saved state and WhatsApp session.',
    );
  }

  let encrypted = null;

  if (localPath) {
    const archivePath = resolveLocalPath(localPath);
    if (!fs.existsSync(archivePath)) {
      logger.info('No local state archive found. Starting fresh.');
      return;
    }
    encrypted = fs.readFileSync(archivePath);
  } else {
    const { repo, token } = githubContext();
    const release = await getRelease(repo, token, releaseTag);
    if (!release) {
      logger.info('No remote state archive found. Starting fresh.');
      return;
    }
    encrypted = await downloadAsset(repo, token, release, assetName);
    if (!encrypted) {
      logger.info('Remote release exists but has no state archive yet. Starting fresh.');
      return;
    }
  }

  const plain = decryptBuffer(encrypted, key);
  const tempPath = path.join(
    os.tmpdir(),
    `request-bot-restore-${process.pid}-${Date.now()}.tar.gz`,
  );
  try {
    fs.writeFileSync(tempPath, plain);
    unpackRuntime(tempPath, config.runtimeDir);
  } finally {
    plain.fill(0);
    fs.rmSync(tempPath, { force: true });
  }

  logger.info(
    `Restored encrypted state archive (${encrypted.length} bytes compressed, ` +
      `${fs.existsSync(path.join(config.runtimeDir, 'wwebjs-auth')) ? 'WhatsApp session present' : 'no WhatsApp session'}).`,
  );
}

async function saveArchive(config, logger) {
  const { key, localPath, releaseTag, assetName } = config.archive;
  if (!key) {
    throw new Error(
      'BOT_STATE_KEY is not set. It is required to encrypt the state and WhatsApp session.',
    );
  }

  const authDir = path.join(config.runtimeDir, 'wwebjs-auth');
  const sessionMarker = path.join(config.runtimeDir, SESSION_MARKER);
  if (fs.existsSync(authDir) && !fs.existsSync(sessionMarker)) {
    logger.warn(
      'WhatsApp did not reach the ready state, so the saved session was left untouched.',
    );
    return;
  }

  const tempPath = path.join(
    os.tmpdir(),
    `request-bot-save-${process.pid}-${Date.now()}.tar.gz`,
  );

  try {
    if (!packRuntime(config.runtimeDir, tempPath)) {
      logger.warn('Nothing to archive (no state.json and no WhatsApp session). Skipping upload.');
      return;
    }

    const plain = fs.readFileSync(tempPath);
    const encrypted = encryptBuffer(plain, key);
    plain.fill(0);

    if (localPath) {
      const archivePath = resolveLocalPath(localPath);
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.writeFileSync(archivePath, encrypted);
      logger.info(`Wrote encrypted state archive to ${archivePath} (${encrypted.length} bytes).`);
      return;
    }

    const { repo, token } = githubContext();
    const release = await ensureRelease(repo, token, releaseTag);
    const existing = (release.assets || []).find((asset) => asset.name === assetName);
    if (existing) await deleteAsset(repo, token, existing.id);
    await uploadAsset(repo, token, release.id, assetName, encrypted);
    logger.info(
      `Uploaded encrypted state archive to ${repo} release "${releaseTag}" (${encrypted.length} bytes).`,
    );
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

module.exports = {
  encryptBuffer,
  decryptBuffer,
  packRuntime,
  unpackRuntime,
  restoreArchive,
  saveArchive,
};
