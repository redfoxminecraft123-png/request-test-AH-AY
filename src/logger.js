'use strict';

function createLogger(prefix = 'request-bot') {
  const write = (level, message) => {
    const time = new Date().toISOString();
    console.log(`${time} [${prefix}] ${level} ${message}`);
  };

  return {
    info: (message) => write('INFO', message),
    warn: (message) => write('WARN', message),
    error: (message) => write('ERROR', message),
  };
}

module.exports = { createLogger };
