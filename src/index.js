'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createApi } = require('./api');
const { collectVideos } = require('./collect');
const { loadState, saveState, diffVideos, markVideosSeen } = require('./state');
const { messageForRun } = require('./message');
const {
  createClient,
  initializeClient,
  findGroup,
  sendTextToGroup,
  destroyClient,
  isTransientClientError,
} = require('./whatsapp');
const { saveArchive } = require('./archive');

process.on('unhandledRejection', (error) => {
  const message = error && error.message ? error.message : String(error);
  if (isTransientClientError(error)) {
    console.warn(`[request-bot] WARN Ignored a WhatsApp client error: ${message}`);
    return;
  }
  console.error(`[request-bot] ERROR ${message}`);
  process.exitCode = 1;
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearSessionMarker(config) {
  fs.rmSync(path.join(config.runtimeDir, '.session-ok'), { force: true });
}

function markSessionReady(config) {
  fs.mkdirSync(config.runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(config.runtimeDir, '.session-ok'), new Date().toISOString());
}

function logErrors(errors, logger) {
  for (const error of errors) {
    const where =
      error.scope === 'teacher'
        ? `teacher ${error.id}`
        : error.scope === 'course'
          ? `course ${error.id}`
          : `lesson ${error.id} (course ${error.courseId})`;
    logger.error(`Collection error for ${where}: ${error.message}`);
  }
}

const CONNECT_ATTEMPTS = 2;
const GROUP_LOOKUP_ATTEMPTS = 3;

async function waitForGroup(client, config, logger) {
  let lastError;

  for (let attempt = 1; attempt <= GROUP_LOOKUP_ATTEMPTS; attempt += 1) {
    try {
      return await findGroup(client, config.whatsapp, logger);
    } catch (error) {
      lastError = error;
      logger.warn(`WhatsApp chat list is not ready yet (${error.message}). Waiting.`);
      await sleep(5_000);
    }
  }

  throw lastError;
}

async function connectToGroup(config, logger) {
  let lastError;

  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
    const client = createClient(config, logger);
    try {
      await initializeClient(client, {
        mode: 'check',
        timeoutMs: config.whatsapp.readyTimeoutMs,
        logger,
      });
      // WhatsApp Web reloads once right after login and drops page calls made
      // in that window.
      await sleep(4_000);
      const pages = await client.pupBrowser.pages();
      if (pages.length > 1) logger.warn(`Chrome restored ${pages.length - 1} extra page(s).`);
      const groupId = await waitForGroup(client, config, logger);
      return { client, groupId };
    } catch (error) {
      lastError = error;
      await destroyClient(client, logger);
      if (attempt === CONNECT_ATTEMPTS || !isTransientClientError(error)) {
        throw error;
      }
      logger.warn(
        `WhatsApp connection attempt ${attempt} failed (${error.message}). Retrying with a fresh client.`,
      );
      await sleep(5_000);
    }
  }

  throw lastError;
}

async function runCheck(config, logger) {
  const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
  const state = loadState(config.stateFile);
  const api = createApi(config.api, logger);

  try {
    await api.changeOnlineStatus(true);
    logger.info('Marked the API account as online.');
  } catch (error) {
    logger.warn(`Could not change the API online status (continuing): ${error.message}`);
  }

  const { teachers, videos, errors } = await collectVideos({
    api,
    teacherIds: config.api.teacherIds,
    logger,
  });

  logger.info(
    `Collected ${videos.length} video(s) from ${teachers.length} teacher(s); ${errors.length} collection error(s).`,
  );

  if (teachers.length === 0) {
    logErrors(errors, logger);
    throw new Error('Could not fetch any teacher details. Aborting without changing state.');
  }

  const { firstRun, newVideos } = diffVideos(state, videos);
  const force = config.forceSend;

  if (firstRun && errors.length > 0 && !force) {
    logErrors(errors, logger);
    throw new Error(
      `Refusing to seed the first-run baseline because collection was incomplete (${errors.length} error(s)). The next scheduled run will retry.`,
    );
  }

  if (!firstRun && !force && errors.length > 0 && newVideos.length === 0) {
    logErrors(errors, logger);
    logger.error(
      'Collection was incomplete and no new videos were confirmed. Not sending a potentially misleading "nothing found" message.',
    );
    process.exitCode = 1;
    return;
  }

  const text = messageForRun({ firstRun, force, videos, newVideos });

  if (force) {
    logger.info(`Force send: including all ${videos.length} video(s).`);
  } else if (firstRun) {
    logger.info(`First run: seeding ${videos.length} existing video(s) as already seen.`);
  } else {
    logger.info(`New video(s) detected: ${newVideos.length}.`);
  }

  if (dryRun) {
    logger.info('Dry run enabled: nothing will be sent and state will not be saved.');
    if (process.env.GITHUB_ACTIONS === 'true') {
      logger.info('Message body suppressed in GitHub Actions to keep logs clean.');
    } else {
      console.log('\n----- message preview -----\n');
      console.log(text);
      console.log('\n----- end preview -----\n');
    }
    return;
  }

  clearSessionMarker(config);
  const { client, groupId } = await connectToGroup(config, logger);
  try {
    markSessionReady(config);
    await sendTextToGroup(client, groupId, text, config.whatsapp, logger);
  } finally {
    await destroyClient(client, logger);
  }

  markVideosSeen(state, videos);
  saveState(config.stateFile, state);
  logger.info(`State saved. Known videos: ${Object.keys(state.videos).length}.`);

  if (errors.length > 0) {
    logErrors(errors, logger);
    logger.error(
      'The message was sent, but some feeds could not be checked. The next run will retry those feeds.',
    );
    process.exitCode = 1;
  }
}

async function runPair(config, logger) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    throw new Error(
      'Pairing inside GitHub Actions is disabled because this repository is public. Pair locally with "npm run pair".',
    );
  }

  clearSessionMarker(config);
  const client = createClient(config, logger);
  try {
    await initializeClient(client, {
      mode: 'pair',
      phoneNumber: config.whatsapp.phoneNumber,
      timeoutMs: config.whatsapp.pairTimeoutMs,
      logger,
    });
    markSessionReady(config);
    await sleep(5_000);
  } finally {
    await destroyClient(client, logger);
  }

  logger.info('WhatsApp pairing complete.');

  if (!config.archive.key) {
    logger.warn(
      'BOT_STATE_KEY is not set, so the session was not encrypted/uploaded. Set it and run "npm run state:save".',
    );
    return;
  }

  try {
    await saveArchive(config, logger);
    logger.info('The encrypted session is ready for the 12-hour workflow.');
  } catch (error) {
    logger.warn(
      `Pairing worked, but the encrypted session could not be uploaded: ${error.message}. Run "npm run state:save" after fixing the issue.`,
    );
  }
}

async function main() {
  const config = loadConfig();
  const logger = createLogger('request-bot');
  if (config.mode === 'pair') {
    await runPair(config, logger);
  } else {
    await runCheck(config, logger);
  }
}

main().catch((error) => {
  console.error(`[request-bot] ERROR ${error.message}`);
  process.exitCode = 1;
});
