'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  encryptBuffer,
  decryptBuffer,
  packRuntime,
  unpackRuntime,
} = require('../src/archive');

const hasTar = spawnSync('tar', ['--version'], { encoding: 'utf8' }).status === 0;

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `request-bot-${name}-`));
}

test('encrypts and decrypts an archive', () => {
  const plain = Buffer.from('sensitive session data');
  const encrypted = encryptBuffer(plain, 'correct horse battery staple');
  assert.ok(!encrypted.includes(plain));
  assert.deepEqual(decryptBuffer(encrypted, 'correct horse battery staple'), plain);
});

test('rejects the wrong key', () => {
  const encrypted = encryptBuffer(Buffer.from('data'), 'key-one');
  assert.throws(() => decryptBuffer(encrypted, 'key-two'), /wrong BOT_STATE_KEY/);
});

test('rejects a tampered archive', () => {
  const encrypted = encryptBuffer(Buffer.from('data'), 'key');
  encrypted[encrypted.length - 1] ^= 0xff;
  assert.throws(() => decryptBuffer(encrypted, 'key'), /wrong BOT_STATE_KEY|corrupted/);
});

test('packs and unpacks state and session files', { skip: !hasTar }, () => {
  const root = tempDir('archive');
  const runtime = path.join(root, 'runtime');
  const restored = path.join(root, 'restored');
  const tarPath = path.join(root, 'state.tar.gz');

  try {
    fs.mkdirSync(path.join(runtime, 'wwebjs-auth', 'session-request-bot', 'Default'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(runtime, 'state.json'), '{"initialized":true,"videos":{}}');
    fs.writeFileSync(path.join(runtime, '.session-ok'), 'ready');
    fs.writeFileSync(
      path.join(runtime, 'wwebjs-auth', 'session-request-bot', 'Default', 'data.txt'),
      'session',
    );

    assert.equal(packRuntime(runtime, tarPath), true);
    unpackRuntime(tarPath, restored);

    assert.equal(
      fs.readFileSync(path.join(restored, 'state.json'), 'utf8'),
      '{"initialized":true,"videos":{}}',
    );
    assert.equal(
      fs.readFileSync(
        path.join(restored, 'wwebjs-auth', 'session-request-bot', 'Default', 'data.txt'),
        'utf8',
      ),
      'session',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not pack a session that never reached ready', { skip: !hasTar }, () => {
  const root = tempDir('unready');
  const runtime = path.join(root, 'runtime');
  const tarPath = path.join(root, 'state.tar.gz');

  try {
    fs.mkdirSync(path.join(runtime, 'wwebjs-auth', 'session-request-bot'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(runtime, 'state.json'), '{}');
    fs.writeFileSync(
      path.join(runtime, 'wwebjs-auth', 'session-request-bot', 'data.txt'),
      'session',
    );

    assert.equal(packRuntime(runtime, tarPath), true);
    const listing = spawnSync('tar', ['-tzf', tarPath], { encoding: 'utf8' }).stdout;
    assert.match(listing, /state\.json/);
    assert.doesNotMatch(listing, /wwebjs-auth/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not create an archive when there is nothing to save', { skip: !hasTar }, () => {
  const root = tempDir('empty');
  const tarPath = path.join(root, 'state.tar.gz');
  try {
    assert.equal(packRuntime(path.join(root, 'missing'), tarPath), false);
    assert.equal(fs.existsSync(tarPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
