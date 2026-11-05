const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  anchorHoldMs,
  anchorSlackBlocks,
  maxAnchorSlackBlocks,
  nextAnchor,
  publishAnchor,
} = require('../seed-anchor');
const {
  dialsForAnchor,
  fetchBlockHeader,
  priorTipsFromSeeds,
  readPriorTips,
  resolveSeedAddress,
  sampleSeed,
  sampleSeeds,
} = require('../seed-sample');
const { heightAnchor, heightAnchorMs, heightAheadBlocks } = require('../validate');

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

  it('ignores a height outside the ten-day cap and a missing hash', () => {
    const tooHigh = heightAnchor + heightAheadBlocks + 1;
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

  it('keeps the anchor when the wall clock jumps and the hold clock has not', () => {
    const held = nextAnchor(published, [], now + anchorHoldMs + 60_000, anchorHoldMs, now + 1);

    assert.equal(held, published);
  });
});

describe('anchorSlackBlocks', () => {
  const blockMs = 120_000;
  const anchor = { height: heightAnchor, hash, at: 1_000_000 };

  it('holds the anchor for 12 minutes, which is 6 blocks', () => {
    assert.equal(anchorHoldMs, 12 * 60 * 1000);
    assert.equal(maxAnchorSlackBlocks, 6);
    assert.equal(anchorHoldMs, maxAnchorSlackBlocks * blockMs);
  });

  it('gives no slack to a fresh anchor', () => {
    assert.equal(anchorSlackBlocks(anchor, anchor.at), 0);
    assert.equal(anchorSlackBlocks(anchor, anchor.at + blockMs - 1), 0);
  });

  it('adds one block per full block time of age', () => {
    assert.equal(anchorSlackBlocks(anchor, anchor.at + blockMs), 1);
    assert.equal(anchorSlackBlocks(anchor, anchor.at + 2 * blockMs + 5_000), 2);
    assert.equal(anchorSlackBlocks(anchor, anchor.at + 5 * blockMs), 5);
  });

  it('stops at the blocks that fit in the hold', () => {
    assert.equal(anchorSlackBlocks(anchor, anchor.at + anchorHoldMs), maxAnchorSlackBlocks);
    assert.equal(anchorSlackBlocks(anchor, anchor.at + 10 * anchorHoldMs), maxAnchorSlackBlocks);
  });

  it('gives no slack without a usable anchor age or clock', () => {
    assert.equal(anchorSlackBlocks(null, anchor.at + 3 * blockMs), 0);
    assert.equal(anchorSlackBlocks({ height: heightAnchor, hash }, anchor.at + 3 * blockMs), 0);
    assert.equal(anchorSlackBlocks({ ...anchor, at: 'x' }, anchor.at + 3 * blockMs), 0);
    assert.equal(anchorSlackBlocks(anchor, Number.NaN), 0);
    assert.equal(anchorSlackBlocks(anchor, undefined), 0);
  });

  it('ignores a clock that reads earlier than the anchor', () => {
    assert.equal(anchorSlackBlocks(anchor, anchor.at - 5 * blockMs), 0);
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

    assert.deepEqual(address, { address: '203.0.113.10', reason: null });
  });

  it('rejects a set that contains a blocked address', async () => {
    const address = await resolveSeedAddress(
      'seed1.conceal.network',
      lookup([
        { address: '203.0.113.10', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ])
    );

    assert.deepEqual(address, { address: null, reason: 'blocked' });
  });

  it('returns null when lookup fails', async () => {
    const address = await resolveSeedAddress(
      'seed1.conceal.network',
      lookup(null, new Error('ENOTFOUND'))
    );

    assert.deepEqual(address, { address: null, reason: 'lookup' });
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

  it('keeps the first seed when two names resolve to the same address and port', async () => {
    let hits = 0;
    const server = http.createServer((_request, response) => {
      hits += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'OK', height: heightAnchor, top_block_hash: hash }));
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const { replies, rememberedHosts, droppedHosts } = await sampleSeeds(
        [
          { host: 'seed1.conceal.network', port },
          { host: 'seed2.conceal.network', port },
        ],
        1000,
        new Map(),
        () => '127.0.0.1'
      );

      assert.equal(hits, 1);
      assert.equal(replies[0].height, heightAnchor);
      assert.equal(replies[1], null);
      assert.deepEqual(rememberedHosts, []);
      assert.deepEqual(droppedHosts, ['seed2.conceal.network']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('reports a blocked answer and a failed lookup', async () => {
    const { replies, blockedHosts, lookupFailures } = await sampleSeeds(
      [
        { host: 'seed1.conceal.network', port: 16000 },
        { host: 'seed2.conceal.network', port: 16000 },
      ],
      1000,
      new Map(),
      (host) =>
        host.startsWith('seed1')
          ? { address: null, reason: 'blocked' }
          : { address: null, reason: 'lookup' }
    );

    assert.deepEqual(replies, [null, null]);
    assert.deepEqual(blockedHosts, ['seed1.conceal.network']);
    assert.deepEqual(lookupFailures, ['seed2.conceal.network']);
  });

  it('names the seed that used a remembered address', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'OK', height: heightAnchor, top_block_hash: hash }));
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const { rememberedHosts } = await sampleSeeds(
        [{ host: 'seed1.conceal.network', port: server.address().port }],
        1000,
        new Map([['seed1.conceal.network', '127.0.0.1']]),
        () => null
      );

      assert.deepEqual(rememberedHosts, ['seed1.conceal.network']);
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

describe('prior seed tips', () => {
  const hash = 'a'.repeat(64);
  const prev = 'b'.repeat(64);
  const anchor = { height: 10, hash };

  it('reads H-2 and H-1 from a header at H-1', () => {
    const tips = readPriorTips(
      { status: 'OK', block_header: { height: 9, hash, prev_hash: prev.toUpperCase() } },
      9
    );

    assert.deepEqual(tips, [
      { height: 8, hash: prev },
      { height: 9, hash },
    ]);
  });

  it('ignores a header that is not the requested height', () => {
    assert.deepEqual(
      readPriorTips({ status: 'OK', block_header: { height: 8, hash, prev_hash: prev } }, 9),
      []
    );
    assert.deepEqual(readPriorTips({ status: 'BUSY' }, 9), []);
    assert.deepEqual(readPriorTips(null, 9), []);
    assert.deepEqual(
      readPriorTips({ status: 'OK', block_header: { height: 0, hash, prev_hash: prev } }, 0),
      []
    );
  });

  it('lists every dial whose getinfo matches the anchor, in order', () => {
    const dials = [
      { host: 'seed1.conceal.network', address: '203.0.113.1', port: 16000 },
      { host: 'seed2.conceal.network', address: '203.0.113.2', port: 16000 },
      { host: 'seed3.conceal.network', address: '203.0.113.3', port: 16000 },
    ];
    const replies = [
      { height: 10, top_block_hash: hash },
      { height: 9, top_block_hash: hash },
      { height: 10, top_block_hash: hash.toUpperCase() },
    ];

    assert.deepEqual(dialsForAnchor(dials, replies, anchor), [dials[0], dials[2]]);
    assert.deepEqual(
      dialsForAnchor(dials, [{ height: 10, top_block_hash: 'c'.repeat(64) }], anchor),
      []
    );
  });

  it('stops once three seeds agree and skips the rest', async () => {
    const good = { status: 'OK', block_header: { height: 9, hash, prev_hash: prev } };
    const calls = [];
    const fetchHeader = (host) => {
      calls.push(host);
      return Promise.resolve(host === 'seed1.conceal.network' ? null : good);
    };
    const candidates = [1, 2, 3, 4, 5].map((index) => ({
      host: `seed${index}.conceal.network`,
      address: `203.0.113.${index}`,
      port: 16000,
    }));

    const tips = await priorTipsFromSeeds(candidates, 9, 1000, { fetchHeader, quorum: 3 });

    assert.deepEqual(tips, [
      { height: 8, hash: prev },
      { height: 9, hash },
    ]);
    assert.deepEqual(calls, [
      'seed1.conceal.network',
      'seed2.conceal.network',
      'seed3.conceal.network',
      'seed4.conceal.network',
    ]);
  });

  it('seeds nothing when fewer than three seeds agree', async () => {
    const good = { status: 'OK', block_header: { height: 9, hash, prev_hash: prev } };
    const other = {
      status: 'OK',
      block_header: { height: 9, hash: 'c'.repeat(64), prev_hash: prev },
    };
    const calls = [];
    const fetchHeader = (host) => {
      calls.push(host);
      if (host === 'seed3.conceal.network') {
        return Promise.resolve(other);
      }

      return Promise.resolve(host === 'seed4.conceal.network' ? null : good);
    };
    const candidates = [1, 2, 3, 4].map((index) => ({
      host: `seed${index}.conceal.network`,
      address: `203.0.113.${index}`,
      port: 16000,
    }));

    const tips = await priorTipsFromSeeds(candidates, 9, 1000, { fetchHeader, quorum: 3 });

    assert.deepEqual(tips, []);
    assert.deepEqual(calls, [
      'seed1.conceal.network',
      'seed2.conceal.network',
      'seed3.conceal.network',
      'seed4.conceal.network',
    ]);
  });

  it('posts getblockheaderbyheight and returns the result', async () => {
    const server = http.createServer((request, response) => {
      let body = '';

      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        const parsed = JSON.parse(body);

        assert.equal(request.url, '/json_rpc');
        assert.equal(parsed.method, 'getblockheaderbyheight');
        assert.equal(parsed.params.height, 9);
        assert.equal(request.headers.host, `seed1.conceal.network:${server.address().port}`);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            result: { status: 'OK', block_header: { height: 9, hash, prev_hash: prev } },
          })
        );
      });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const result = await fetchBlockHeader(
        'seed1.conceal.network',
        '127.0.0.1',
        server.address().port,
        9,
        1000
      );

      assert.equal(result.block_header.height, 9);
      assert.deepEqual(readPriorTips(result, 9), [
        { height: 8, hash: prev },
        { height: 9, hash },
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
