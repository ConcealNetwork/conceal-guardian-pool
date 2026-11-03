const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { anchorHoldMs, nextAnchor, publishAnchor } = require('../seed-anchor');
const { resolveSeedAddress, sampleSeed } = require('../seed-sample');
const { heightAnchor, heightAnchorMs, heightWeekBlocks } = require('../validate');

const hash = 'a'.repeat(64);
const other = 'b'.repeat(64);

const reply = (height, tip = hash, status = 'OK') => ({
  status,
  height,
  top_block_hash: tip,
});

describe('publishAnchor', () => {
  const now = heightAnchorMs;

  it('publishes when three replies sit on the median height and share one hash', () => {
    const anchor = publishAnchor(
      [reply(heightAnchor), reply(heightAnchor), reply(heightAnchor), reply(heightAnchor - 1)],
      now
    );

    assert.deepEqual(anchor, { height: heightAnchor, hash });
  });

  it('uses the lower of the two central heights when the count is even', () => {
    const anchor = publishAnchor(
      [
        reply(heightAnchor),
        reply(heightAnchor),
        reply(heightAnchor),
        reply(heightAnchor + 1, other),
      ],
      now
    );

    assert.deepEqual(anchor, { height: heightAnchor, hash });
  });

  it('does not publish when the median height has only one reply', () => {
    assert.equal(
      publishAnchor(
        [reply(heightAnchor), reply(heightAnchor + 1, other), reply(heightAnchor + 2, other)],
        now
      ),
      null
    );
  });

  it('does not publish when the replies on the chosen height disagree on the hash', () => {
    assert.equal(
      publishAnchor(
        [reply(heightAnchor, hash), reply(heightAnchor, hash), reply(heightAnchor, other)],
        now
      ),
      null
    );
  });

  it('does not publish from two replies', () => {
    assert.equal(publishAnchor([reply(heightAnchor), reply(heightAnchor)], now), null);
  });

  it('ignores a height outside the week cap and a missing hash', () => {
    const tooHigh = heightAnchor + heightWeekBlocks + 1;
    const anchor = publishAnchor(
      [
        reply(tooHigh),
        reply(heightAnchor),
        reply(heightAnchor),
        reply(heightAnchor),
        { status: 'OK', height: heightAnchor },
      ],
      now
    );

    assert.deepEqual(anchor, { height: heightAnchor, hash });
  });
});

describe('nextAnchor', () => {
  const now = heightAnchorMs;
  const published = {
    height: heightAnchor,
    hash,
    at: now,
  };

  it('replaces the held anchor when a round publishes', () => {
    const anchor = nextAnchor(
      null,
      [reply(heightAnchor), reply(heightAnchor), reply(heightAnchor)],
      now
    );

    assert.deepEqual(anchor, published);
  });

  it('keeps the previous anchor through a failed round inside the hold', () => {
    const anchor = nextAnchor(published, [], now + anchorHoldMs - 1);

    assert.equal(anchor, published);
  });

  it('clears the anchor when the hold has elapsed', () => {
    assert.equal(nextAnchor(published, [], now + anchorHoldMs), null);
  });
});

describe('resolveSeedAddress', () => {
  const lookup =
    (addresses, error = null) =>
    (_host, _options, callback) => {
      callback(error, addresses);
    };

  it('returns the first public address', async () => {
    const address = await resolveSeedAddress(
      'seed1.conceal.network',
      lookup([{ address: '203.0.113.10', family: 4 }])
    );

    assert.equal(address, '203.0.113.10');
  });

  it('rejects a set that contains a blocked address', async () => {
    const address = await resolveSeedAddress(
      'seed1.conceal.network',
      lookup([
        { address: '203.0.113.10', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ])
    );

    assert.equal(address, null);
  });

  it('returns null when lookup fails', async () => {
    const address = await resolveSeedAddress(
      'seed1.conceal.network',
      lookup(null, new Error('ENOTFOUND'))
    );

    assert.equal(address, null);
  });
});

describe('sampleSeed', () => {
  const listen = () =>
    new Promise((resolve) => {
      const server = http.createServer((request, response) => {
        assert.equal(request.url, '/getinfo');
        assert.equal(request.headers.host, `seed1.conceal.network:${server.address().port}`);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'OK', height: heightAnchor, top_block_hash: hash }));
      });

      server.listen(0, '127.0.0.1', () => resolve(server));
    });

  it('dials the resolved address and remembers it', async () => {
    const server = await listen();
    const pins = new Map();

    try {
      const info = await sampleSeed(
        { host: 'seed1.conceal.network', port: server.address().port },
        1000,
        pins,
        () => '127.0.0.1'
      );

      assert.equal(info.height, heightAnchor);
      assert.equal(pins.get('seed1.conceal.network'), '127.0.0.1');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('dials the remembered address when the name does not resolve', async () => {
    const server = await listen();
    const pins = new Map([['seed1.conceal.network', '127.0.0.1']]);

    try {
      const info = await sampleSeed(
        { host: 'seed1.conceal.network', port: server.address().port },
        1000,
        pins,
        () => null
      );

      assert.equal(info.height, heightAnchor);
      assert.equal(pins.get('seed1.conceal.network'), '127.0.0.1');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('returns null when the name fails and nothing is remembered', async () => {
    const info = await sampleSeed(
      { host: 'seed1.conceal.network', port: 16000 },
      1000,
      new Map(),
      () => null
    );

    assert.equal(info, null);
  });
});
