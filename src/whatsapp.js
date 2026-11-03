'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { messageChunks } = require('./message');

const CLIENT_ID = 'request-bot';

class SessionExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

class GroupNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GroupNotFoundError';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function removePath(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {}
}

function prepareProfile(authDir) {
  const sessionDir = path.join(authDir, `session-${CLIENT_ID}`);

  for (const name of [
    'SingletonLock',
    'SingletonCookie',
    'SingletonSocket',
    'lockfile',
    'DevToolsActivePort',
  ]) {
    removePath(path.join(sessionDir, name));
  }

  // Restored tabs load WhatsApp Web again and take the single-window lock.
  for (const name of ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs', 'Sessions']) {
    removePath(path.join(sessionDir, 'Default', name));
  }

  const preferencesPath = path.join(sessionDir, 'Default', 'Preferences');
  try {
    const preferences = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
    preferences.profile = { ...preferences.profile, exit_type: 'Normal' };
    fs.writeFileSync(preferencesPath, JSON.stringify(preferences));
  } catch {}
}

const TRANSIENT_PATTERNS = [
  'Target closed',
  'Session closed',
  'Execution context was destroyed',
  'detached Frame',
  'Promise was collected',
  'Protocol error',
];

function isTransientClientError(error) {
  const message = String(error && error.message ? error.message : error);
  return TRANSIENT_PATTERNS.some((pattern) => message.includes(pattern));
}

function createClient(config, logger) {
  fs.mkdirSync(config.authDir, { recursive: true });
  prepareProfile(config.authDir);

  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  };

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  logger.info('Starting WhatsApp Web client');
  return new Client({
    authStrategy: new LocalAuth({ dataPath: config.authDir, clientId: CLIENT_ID }),
    puppeteer: launchOptions,
    webVersionCache: { type: 'none' },
  });
}

function formatPairingCode(code) {
  const compact = String(code || '').replace(/[^A-Za-z0-9]/g, '');
  if (compact.length === 8) return `${compact.slice(0, 4)}-${compact.slice(4)}`;
  return compact || String(code || '');
}

function initializeClient(client, { mode, phoneNumber = '', timeoutMs, logger }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let pairingBusy = false;
    let lastPairingRequest = 0;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    const timer = setTimeout(() => {
      finish(
        new Error(
          `WhatsApp did not become ready within ${Math.round(timeoutMs / 1000)} seconds`,
        ),
      );
    }, timeoutMs);

    client.once('ready', () => {
      logger.info('WhatsApp client is ready');
      finish();
    });

    client.once('auth_failure', (message) => {
      finish(new Error(`WhatsApp authentication failed: ${message}`));
    });

    client.on('disconnected', (reason) => {
      logger.warn(`WhatsApp disconnected: ${reason}`);
      if (!settled) finish(new Error(`WhatsApp disconnected: ${reason}`));
    });

    client.on('loading_screen', (percent, message) => {
      logger.info(`WhatsApp loading ${percent}%${message ? ` - ${message}` : ''}`);
    });

    client.on('change_state', (state) => {
      logger.info(`WhatsApp state: ${state}`);
    });

    client.on('qr', async (qr) => {
      if (mode !== 'pair') {
        finish(
          new SessionExpiredError(
            'No valid WhatsApp session. Pair locally with "npm run pair", then upload it with "npm run state:save".',
          ),
        );
        return;
      }

      logger.info('WhatsApp needs to be linked to this computer.');

      if (phoneNumber) {
        const now = Date.now();
        if (pairingBusy || now - lastPairingRequest < 20_000) return;
        pairingBusy = true;
        lastPairingRequest = now;
        try {
          const code = await client.requestPairingCode(phoneNumber);
          logger.info('==============================================');
          logger.info(`PAIRING CODE: ${formatPairingCode(code)}`);
          logger.info('Enter it in WhatsApp > Linked devices > Link with phone number.');
          logger.info('==============================================');
        } catch (error) {
          logger.error(`Could not request a pairing code: ${error.message}`);
          logger.info('Falling back to the QR code.');
          qrcode.generate(qr, { small: true });
        } finally {
          pairingBusy = false;
        }
      } else {
        qrcode.generate(qr, { small: true });
        logger.info('Scan the QR above: WhatsApp > Linked devices > Link a device.');
      }
    });

    client.initialize().catch((error) => {
      finish(new Error(`Could not start the WhatsApp client: ${error.message}`));
    });
  });
}

async function findGroup(client, { groupName, groupId }, logger) {
  const found = await client.pupPage.evaluate(
    ({ id, name }) => {
      const chats = window.require('WAWebCollections').Chat.getModelsArray();
      const groups = chats.filter((chat) => String(chat.id._serialized).endsWith('@g.us'));
      const title = (chat) => String(chat.name || chat.formattedTitle || '').trim();

      if (id) {
        return groups.some((chat) => String(chat.id._serialized) === id) ? id : null;
      }

      const target = name.trim().toLowerCase();
      const match =
        groups.find((chat) => title(chat) === name.trim()) ||
        groups.find((chat) => title(chat).toLowerCase() === target);
      return match ? String(match.id._serialized) : null;
    },
    { id: groupId || '', name: groupName || '' },
  );

  if (!found) {
    throw new GroupNotFoundError(
      groupId
        ? `WhatsApp group id "${groupId}" was not found.`
        : `WhatsApp group "${groupName}" was not found.`,
    );
  }

  logger.info(
    groupId ? 'Using the configured WhatsApp group id.' : `Found WhatsApp group "${groupName}".`,
  );
  return found;
}

async function sendTextToGroup(client, groupId, text, whatsappConfig, logger) {
  const chunks = messageChunks(text, whatsappConfig.chunkSize);

  for (let index = 0; index < chunks.length; index += 1) {
    await client.pupPage.evaluate(
      async (chatId, content) => {
        const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
        if (!chat) throw new Error(`WhatsApp chat ${chatId} is not available`);
        await window.WWebJS.sendMessage(chat, content, {});
      },
      groupId,
      chunks[index],
    );
    logger.info(
      `Sent WhatsApp message part ${index + 1}/${chunks.length} (${chunks[index].length} chars)`,
    );
    if (index < chunks.length - 1) await sleep(1_000);
  }
}

async function destroyClient(client, logger) {
  if (!client) return;
  const browser = client.pupBrowser;
  try {
    await Promise.race([
      client.destroy(),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ]);
  } catch (error) {
    logger.warn(`Could not close the WhatsApp client cleanly: ${error.message}`);
  }

  // A leftover browser keeps the profile locked for the next run.
  try {
    const process = browser && browser.process();
    if (process && process.exitCode === null) process.kill('SIGKILL');
  } catch {}
}

module.exports = {
  SessionExpiredError,
  GroupNotFoundError,
  isTransientClientError,
  createClient,
  initializeClient,
  findGroup,
  sendTextToGroup,
  destroyClient,
};
