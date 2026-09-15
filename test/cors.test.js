// Copyright (c) 2019 -2026, Taegus Cromis, The Conceal Developers
//
// Please see the included LICENSE file for more information.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { publicGetCors, concealWriteCors } = require('../middleware-cors.js');

function startApp() {
  const app = express();
  app.get('/pool/list', publicGetCors, (_req, res) => {
    res.json({ success: true });
  });
  app.options('/pool/update', concealWriteCors);
  app.post('/pool/update', concealWriteCors, (_req, res) => {
    res.json({ success: true });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

async function request(port, { method, path, origin, headers = {} }) {
  const h = { ...headers };
  if (origin !== undefined) h.Origin = origin;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: h });
  return {
    status: res.status,
    allowOrigin: res.headers.get('access-control-allow-origin'),
    allowCredentials: res.headers.get('access-control-allow-credentials'),
    allowMethods: res.headers.get('access-control-allow-methods'),
    allowHeaders: res.headers.get('access-control-allow-headers'),
  };
}

describe('CORS policy', () => {
  it('allows any Origin on GET', async () => {
    const { server, port } = await startApp();
    try {
      const res = await request(port, {
        method: 'GET',
        path: '/pool/list',
        origin: 'https://evil.example',
      });
      assert.equal(res.status, 200);
      assert.equal(res.allowOrigin, '*');
      assert.equal(res.allowCredentials, null);
    } finally {
      server.close();
    }
  });

  it('allows Conceal UI preflight for POST with credentials and Authorization', async () => {
    const { server, port } = await startApp();
    try {
      const res = await request(port, {
        method: 'OPTIONS',
        path: '/pool/update',
        origin: 'https://wallet.conceal.network',
        headers: {
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,authorization',
        },
      });
      assert.equal(res.status, 204);
      assert.equal(res.allowOrigin, 'https://wallet.conceal.network');
      assert.equal(res.allowCredentials, 'true');
      assert.match(res.allowMethods, /POST/);
      assert.match(res.allowHeaders, /Authorization/i);
    } finally {
      server.close();
    }
  });

  it('rejects unknown Origin on POST preflight', async () => {
    const { server, port } = await startApp();
    try {
      const res = await request(port, {
        method: 'OPTIONS',
        path: '/pool/update',
        origin: 'https://evil.example',
        headers: {
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      });
      assert.equal(res.allowOrigin, null);
    } finally {
      server.close();
    }
  });

  it('allows Joe node POST with no Origin header', async () => {
    const { server, port } = await startApp();
    try {
      const res = await request(port, {
        method: 'POST',
        path: '/pool/update',
      });
      assert.equal(res.status, 200);
    } finally {
      server.close();
    }
  });

  it('reflects Conceal Origin on POST response', async () => {
    const { server, port } = await startApp();
    try {
      const res = await request(port, {
        method: 'POST',
        path: '/pool/update',
        origin: 'https://explorer.conceal.network',
      });
      assert.equal(res.status, 200);
      assert.equal(res.allowOrigin, 'https://explorer.conceal.network');
      assert.equal(res.allowCredentials, 'true');
    } finally {
      server.close();
    }
  });
});
