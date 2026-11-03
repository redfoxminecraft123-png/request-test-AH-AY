'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isTransientClientError,
  SessionExpiredError,
  GroupNotFoundError,
} = require('../src/whatsapp');

test('treats puppeteer page errors as transient', () => {
  for (const message of [
    'Protocol error (Runtime.callFunctionOn): Target closed',
    'Protocol error (Runtime.callFunctionOn): Session closed',
    'Execution context was destroyed.',
    'Promise was collected',
  ]) {
    assert.equal(isTransientClientError(new Error(message)), true, message);
  }
});

test('does not treat login and group errors as transient', () => {
  assert.equal(isTransientClientError(new SessionExpiredError('no session')), false);
  assert.equal(isTransientClientError(new GroupNotFoundError('no group')), false);
  assert.equal(isTransientClientError(new Error('network down')), false);
  assert.equal(isTransientClientError(null), false);
});
