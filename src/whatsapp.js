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

function cleanStaleLocks(authDir) {
  const sessionDir = path.join(authDir, `session-${CLIENT_ID}`);
  for (const name of [
    'SingletonLock',
    'SingletonCookie',
    'SingletonSocket',
    'lockfile',
    'DevToolsActivePort',
  ]) {
    const target = path.join(sessionDir, name);
    try {
      const stat = fs.lstatSync(target);
      if (stat.isDirectory()) {
        fs.rmSync(target, { recursive: true, force: true });
      } else {
        fs.rmSync(target, { force: true });
      }
    } catch {
      // Nothing to clean up.
    }
  }
}

function createClient(config, logger) {
  fs.mkdirSync(config.authDir, { recursive: true });
  fs.mkdirSync(config.cacheDir, { recursive: true });
  cleanStaleLocks(config.authDir);

  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
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
    webVersionCache: { type: 'local', path: config.cacheDir },
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
  if (groupId) {
    let chat;
    try {
      chat = await client.getChatById(groupId);
    } catch {
      throw new GroupNotFoundError(`WhatsApp group id "${groupId}" was not found.`);
    }
    if (!chat || chat.isGroup !== true) {
      throw new GroupNotFoundError(`WhatsApp chat "${groupId}" is not a group.`);
    }
    logger.info('Using the configured WhatsApp group id.');
    return chat;
  }

  const chats = await client.getChats();
  const groups = chats.filter((chat) => chat && chat.isGroup === true);
  const normalize = (value) => String(value || '').trim().toLowerCase();
  const target = normalize(groupName);
  const match =
    groups.find((chat) => chat.name === groupName) ||
    groups.find((chat) => normalize(chat.name) === target);

  if (!match) {
    throw new GroupNotFoundError(
      `WhatsApp group "${groupName}" was not found (${groups.length} groups visible to this account).`,
    );
  }

  logger.info(`Found WhatsApp group "${groupName}".`);
  return match;
}

async function sendTextToGroup(client, text, whatsappConfig, logger) {
  const chat = await findGroup(client, whatsappConfig, logger);
  const chunks = messageChunks(text, whatsappConfig.chunkSize);

  for (let index = 0; index < chunks.length; index += 1) {
    await chat.sendMessage(chunks[index]);
    logger.info(
      `Sent WhatsApp message part ${index + 1}/${chunks.length} (${chunks[index].length} chars)`,
    );
    if (index < chunks.length - 1) await sleep(1_000);
  }
}

async function destroyClient(client, logger) {
  if (!client) return;
  try {
    await Promise.race([
      client.destroy(),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  } catch (error) {
    logger.warn(`Could not close the WhatsApp client cleanly: ${error.message}`);
  }
}

module.exports = {
  SessionExpiredError,
  GroupNotFoundError,
  createClient,
  initializeClient,
  findGroup,
  sendTextToGroup,
  destroyClient,
};
