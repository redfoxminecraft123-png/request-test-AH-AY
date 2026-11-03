'use strict';

const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { restoreArchive, saveArchive } = require('../src/archive');

async function main() {
  const action = process.argv[2];
  const config = loadConfig();
  const logger = createLogger('state');

  if (action === 'restore') {
    await restoreArchive(config, logger);
  } else if (action === 'save') {
    await saveArchive(config, logger);
  } else {
    console.error('Usage: node scripts/state-archive.js restore|save');
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(`[state] ERROR ${error.message}`);
  process.exitCode = 1;
});
