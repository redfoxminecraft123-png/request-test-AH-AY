'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApi } = require('../src/api');

const logger = { info() {}, warn() {}, error() {} };

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('sends the bearer token and api-key headers', async () => {
  let received = null;
  const { server, baseUrl } = await listen((request, response) => {
    received = request.headers;
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: true, data: { ok: true } }));
  });

  try {
    const api = createApi(
      {
        baseUrl,
        authorization: 'secret-token',
        apiKey: 'secret-key',
        timeoutMs: 5_000,
        retries: 0,
      },
      logger,
    );
    const result = await api.fetchTeacherDetails(231);
    assert.equal(received.authorization, 'Bearer secret-token');
    assert.equal(received['api-key'], 'secret-key');
    assert.deepEqual(result.data, { ok: true });
  } finally {
    await close(server);
  }
});

test('accepts an authorization value that already has the Bearer prefix', async () => {
  let received = null;
  const { server, baseUrl } = await listen((request, response) => {
    received = request.headers;
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: true, data: {} }));
  });

  try {
    const api = createApi(
      {
        baseUrl,
        authorization: 'Bearer already-prefixed',
        apiKey: 'secret-key',
        timeoutMs: 5_000,
        retries: 0,
      },
      logger,
    );
    await api.changeOnlineStatus(true);
    assert.equal(received.authorization, 'Bearer already-prefixed');
  } finally {
    await close(server);
  }
});

test('throws when the API returns status false', async () => {
  const { server, baseUrl } = await listen((request, response) => {
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: false, message: 'not allowed' }));
  });

  try {
    const api = createApi(
      {
        baseUrl,
        authorization: 'token',
        apiKey: 'key',
        timeoutMs: 5_000,
        retries: 0,
      },
      logger,
    );
    await assert.rejects(() => api.fetchCourseDetails(1), /not allowed/);
  } finally {
    await close(server);
  }
});

test('retries a server error and then succeeds', { timeout: 10_000 }, async () => {
  let attempts = 0;
  const { server, baseUrl } = await listen((request, response) => {
    attempts += 1;
    request.resume();
    response.setHeader('content-type', 'application/json');
    if (attempts === 1) {
      response.statusCode = 500;
      response.end(JSON.stringify({ status: false }));
      return;
    }
    response.end(JSON.stringify({ status: true, data: { ok: true } }));
  });

  try {
    const api = createApi(
      {
        baseUrl,
        authorization: 'token',
        apiKey: 'key',
        timeoutMs: 5_000,
        retries: 1,
      },
      logger,
    );
    const result = await api.fetchLessonSessions(1, 2);
    assert.equal(attempts, 2);
    assert.deepEqual(result.data, { ok: true });
  } finally {
    await close(server);
  }
});
