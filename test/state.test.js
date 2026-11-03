'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  freshState,
  loadState,
  saveState,
  diffVideos,
  markVideosSeen,
} = require('../src/state');

function tempFile(name = 'state.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-bot-state-'));
  return { dir, file: path.join(dir, name) };
}

function video(sessionId) {
  return {
    sessionId: String(sessionId),
    teacherId: 1,
    teacherName: 'Teacher',
    courseId: 10,
    courseTitle: 'Course',
    lessonId: 100,
    lessonTitle: 'Lesson',
    title: `Video ${sessionId}`,
    link: `https://example.com/${sessionId}`,
  };
}

test('missing state starts fresh and treats the first run as a baseline', () => {
  const { dir, file } = tempFile();
  try {
    const state = loadState(file);
    assert.equal(state.initialized, false);
    assert.deepEqual(state.videos, {});
    assert.deepEqual(diffVideos(state, [video(1)]), { firstRun: true, newVideos: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only unseen video ids are reported as new', () => {
  const state = freshState();
  markVideosSeen(state, [video(1), video(2)], '2026-01-01T00:00:00.000Z');

  const result = diffVideos(state, [video(1), video(2), video(3)]);
  assert.equal(result.firstRun, false);
  assert.deepEqual(result.newVideos.map((item) => item.sessionId), ['3']);
});

test('state survives save and load and preserves firstSeenAt', () => {
  const { dir, file } = tempFile();
  try {
    const state = freshState();
    markVideosSeen(state, [video(1)], '2026-01-01T00:00:00.000Z');
    saveState(file, state);

    const loaded = loadState(file);
    assert.equal(loaded.initialized, true);
    assert.equal(loaded.videos['1'].firstSeenAt, '2026-01-01T00:00:00.000Z');

    markVideosSeen(loaded, [video(1), video(2)], '2026-01-02T00:00:00.000Z');
    assert.equal(loaded.videos['1'].firstSeenAt, '2026-01-01T00:00:00.000Z');
    assert.equal(loaded.videos['1'].lastSeenAt, '2026-01-02T00:00:00.000Z');
    assert.equal(loaded.videos['2'].firstSeenAt, '2026-01-02T00:00:00.000Z');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt state file fails instead of silently resetting', () => {
  const { dir, file } = tempFile();
  try {
    fs.writeFileSync(file, '{not json');
    assert.throws(() => loadState(file), /not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
