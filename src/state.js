'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATE_VERSION = 1;

function freshState() {
  return {
    version: STATE_VERSION,
    initialized: false,
    lastCheckAt: null,
    videos: {},
  };
}

function loadState(filePath) {
  if (!fs.existsSync(filePath)) return freshState();

  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `State file ${filePath} is not valid JSON. Refusing to reset it automatically so old videos are not re-announced.`,
    );
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !parsed.videos ||
    typeof parsed.videos !== 'object' ||
    Array.isArray(parsed.videos)
  ) {
    throw new Error(
      `State file ${filePath} has an unexpected shape. Refusing to reset it automatically.`,
    );
  }

  return {
    version: Number(parsed.version) || STATE_VERSION,
    initialized: parsed.initialized === true,
    lastCheckAt: typeof parsed.lastCheckAt === 'string' ? parsed.lastCheckAt : null,
    videos: parsed.videos,
  };
}

function saveState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function diffVideos(state, videos) {
  if (!state.initialized) {
    return { firstRun: true, newVideos: [] };
  }

  const newVideos = videos.filter(
    (video) => !Object.prototype.hasOwnProperty.call(state.videos, video.sessionId),
  );
  return { firstRun: false, newVideos };
}

function markVideosSeen(state, videos, now = new Date().toISOString()) {
  for (const video of videos) {
    const previous = state.videos[video.sessionId];
    state.videos[video.sessionId] = {
      ...(previous || {}),
      ...video,
      firstSeenAt: (previous && previous.firstSeenAt) || now,
      lastSeenAt: now,
    };
  }

  state.initialized = true;
  state.lastCheckAt = now;
  state.version = STATE_VERSION;
  return state;
}

module.exports = {
  freshState,
  loadState,
  saveState,
  diffVideos,
  markVideosSeen,
};
