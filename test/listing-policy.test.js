const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  applyListingUpdate,
  defaultPrefixCap,
  ipv4Prefix,
  listingKey,
  mustProbe,
  occupantIdForKey,
  pickWeightedNode,
  preserveProbedChain,
  probeSkipMs,
  selectionWeights,
  syncedNodes,
  tenureWeight,
} = require('../listing-policy');

const ipNode = (id, host = '203.0.113.10', port = 16000) => ({
  id,
  nodeHost: host,
  nodePort: port,
});

const domainNode = (id, host = 'ccxapi.conceal.network/daemon') => ({
  id,
  nodeHost: '203.0.113.10',
  nodePort: 16000,
  url: { host, port: '' },
});

describe('listingKey', () => {
  it('uses nodeHost and nodePort when there is no domain url', () => {
    const data = ipNode('u1');
    assert.equal(listingKey(data), `${data.nodeHost.toLowerCase()}:${data.nodePort}`);
  });

  it('uses port 443 when a domain url omits the port', () => {
    const data = domainNode('u1');
    assert.equal(listingKey(data), `${data.url.host.toLowerCase()}:443`);
  });
});

describe('mustProbe', () => {
  const now = 1_000_000;
  const data = ipNode('u1');

  it('probes when the id is new', () => {
    assert.equal(mustProbe(null, data, null, now), true);
  });

  it('probes when the listing key changed', () => {
    const existing = ipNode('u1', '198.51.100.7', 16000);
    assert.equal(mustProbe(existing, data, now - 1000, now), true);
  });

  it('skips when the same key was probed inside the skip window', () => {
    const existing = ipNode('u1');
    assert.equal(mustProbe(existing, data, now - 60 * 1000, now), false);
  });

  it('probes when the last probe is older than the skip window', () => {
    const existing = ipNode('u1');
    assert.equal(mustProbe(existing, data, now - probeSkipMs - 1, now), true);
  });
});

describe('applyListingUpdate', () => {
  it('rejects a new unreachable node and does not evict', () => {
    const data = ipNode('u-new');
    const result = applyListingUpdate({
      data,
      existing: null,
      reachable: false,
      occupantId: 'u-old',
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'new-unreachable');
    assert.equal(result.evictId, undefined);
  });

  it('keeps last probed chain fields when a same-key probe fails', () => {
    const existing = {
      ...ipNode('u1'),
      blockchain: { height: 2159003, fee_address: '', status: 'OK' },
    };
    const data = {
      ...ipNode('u1'),
      blockchain: { height: 12, fee_address: 'ccx7x', status: 'LIE' },
    };
    const result = applyListingUpdate({
      data,
      existing,
      reachable: false,
      occupantId: undefined,
    });

    assert.equal(result.ok, true);
    assert.equal(result.store.blockchain.height, existing.blockchain.height);
    assert.equal(result.store.blockchain.fee_address, existing.blockchain.fee_address);
    assert.equal(result.store.blockchain.status, existing.blockchain.status);
  });

  it('stores a new reachable node', () => {
    const data = ipNode('u-new');
    const result = applyListingUpdate({
      data,
      existing: null,
      reachable: true,
      occupantId: undefined,
    });

    assert.equal(result.ok, true);
    assert.equal(result.store.id, data.id);
    assert.equal(result.evictId, undefined);
  });

  it('rejects a move to an unreachable host and does not evict', () => {
    const existing = ipNode('u1', '198.51.100.7', 16000);
    const data = ipNode('u1');
    const result = applyListingUpdate({
      data,
      existing,
      reachable: false,
      occupantId: undefined,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'move-unreachable');
    assert.equal(result.evictId, undefined);
  });

  it('stores a move to a reachable host', () => {
    const existing = ipNode('u1', '198.51.100.7', 16000);
    const data = ipNode('u1');
    const result = applyListingUpdate({
      data,
      existing,
      reachable: true,
      occupantId: undefined,
    });

    assert.equal(result.ok, true);
    assert.equal(result.store.id, data.id);
    assert.equal(listingKey(result.store), listingKey(data));
  });

  it('evicts the occupant only when the new id is reachable', () => {
    const occupant = ipNode('u-old');
    const data = ipNode('u-new');
    const rows = [occupant];

    const fail = applyListingUpdate({
      data,
      existing: null,
      reachable: false,
      occupantId: occupantIdForKey(rows, listingKey(data), data.id),
    });
    assert.equal(fail.ok, false);
    assert.equal(fail.evictId, undefined);

    const ok = applyListingUpdate({
      data,
      existing: null,
      reachable: true,
      occupantId: occupantIdForKey(rows, listingKey(data), data.id),
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.evictId, occupant.id);
  });
});

describe('preserveProbedChain', () => {
  it('keeps last probed height, fee and daemon status', () => {
    const incoming = {
      id: 'u1',
      blockchain: { height: 100, fee_address: 'ccx7posted', status: 'LIE' },
    };
    const existing = {
      id: 'u1',
      blockchain: { height: 2159003, fee_address: '', status: 'OK' },
    };

    const stored = preserveProbedChain(incoming, existing);

    assert.equal(stored.blockchain.height, existing.blockchain.height);
    assert.equal(stored.blockchain.fee_address, existing.blockchain.fee_address);
    assert.equal(stored.blockchain.status, existing.blockchain.status);
  });

  it('keeps last probed daemon version and other getinfo fields on skip', () => {
    const incoming = {
      id: 'u1',
      version: '1.2.3',
      blockchain: { height: 100, fee_address: 'ccx7posted', status: 'LIE' },
    };
    const existing = {
      id: 'u1',
      version: '1.2.2',
      blockchain: {
        height: 2159003,
        fee_address: '',
        status: 'OK',
        version: '6.7.5',
        difficulty: 34100000,
        hashrate: 42,
      },
    };

    const stored = preserveProbedChain(incoming, existing);

    assert.equal(stored.version, '1.2.3');
    assert.equal(stored.blockchain.version, '6.7.5');
    assert.equal(stored.blockchain.difficulty, 34100000);
    assert.equal(stored.blockchain.hashrate, 42);
    assert.equal(stored.blockchain.height, existing.blockchain.height);
  });
});

describe('synced filter', () => {
  it('keeps reachable rows at or above the seed anchor minus 2', () => {
    const rows = [
      { status: { isReachable: true }, blockchain: { height: 2159003 } },
      { status: { isReachable: true }, blockchain: { height: 2159001 } },
      { status: { isReachable: true }, blockchain: { height: 2159000 } },
      { status: { isReachable: true }, blockchain: { height: 2159103 } },
      { status: { isReachable: false }, blockchain: { height: 2159003 } },
    ];

    assert.deepEqual(
      syncedNodes(rows, true, 2159003).map((row) => row.blockchain.height),
      [2159003, 2159001, 2159103]
    );
  });

  it('returns no synced rows when the seed anchor is missing', () => {
    const rows = [{ status: { isReachable: true }, blockchain: { height: 2159003 } }];

    assert.deepEqual(syncedNodes(rows, true, null), []);
    assert.deepEqual(syncedNodes(rows, false, null), rows);
  });
});

describe('ipv4Prefix', () => {
  it('keeps the first three octets of a dotted-quad host', () => {
    assert.equal(ipv4Prefix('192.0.1.7'), '192.0.1');
    assert.equal(ipv4Prefix('203.0.113.10'), '203.0.113');
  });

  it('returns null for anything that is not a dotted-quad host', () => {
    assert.equal(ipv4Prefix('ccxapi.conceal.network'), null);
    assert.equal(ipv4Prefix(null), null);
  });
});

describe('tenureWeight', () => {
  const now = Date.parse('2026-11-04T02:00:00.000Z');
  const nodeSeen = (iso) => ({ status: { firstSeen: iso } });

  it('weights a node without firstSeen as brand new', () => {
    assert.equal(tenureWeight({ status: {} }, now), 1);
    assert.equal(tenureWeight({}, now), 1);
  });

  it('adds one weight step per full ten minutes of presence', () => {
    assert.equal(tenureWeight(nodeSeen('2026-11-04T01:59:00.000Z'), now), 1);
    assert.equal(tenureWeight(nodeSeen('2026-11-04T01:50:00.000Z'), now), 2);
    assert.equal(tenureWeight(nodeSeen('2026-11-04T01:31:00.000Z'), now), 3);
    assert.equal(tenureWeight(nodeSeen('2026-11-04T01:29:00.000Z'), now), 4);
  });

  it('caps the tenure bonus', () => {
    assert.equal(tenureWeight(nodeSeen('2026-11-03T20:00:00.000Z'), now), 6);
  });
});

describe('selectionWeights', () => {
  const now = Date.parse('2026-11-04T00:00:00.000Z');

  it('caps the combined weight a single /24 prefix can contribute', () => {
    const nodes = [];
    for (let index = 0; index < 20; index++) {
      nodes.push({ id: `s${index}`, nodeHost: `198.51.100.${index + 1}`, nodePort: 16000 });
    }

    const weights = selectionWeights(nodes, defaultPrefixCap, now);

    assert.equal(
      weights.reduce((sum, weight) => sum + weight, 0),
      defaultPrefixCap
    );
    assert.equal(
      weights.slice(0, defaultPrefixCap).every((weight) => weight === 1),
      true
    );
    assert.equal(
      weights.slice(defaultPrefixCap).every((weight) => weight === 0),
      true
    );
  });

  it('gives each distinct prefix its own budget', () => {
    const nodes = [
      { id: 'a', nodeHost: '192.0.1.1', nodePort: 16000 },
      { id: 'b', nodeHost: '192.0.2.1', nodePort: 16000 },
      { id: 'c', nodeHost: 'ccx1.example.org', nodePort: 16000 },
      { id: 'd', nodeHost: 'ccx2.example.org', nodePort: 16000 },
    ];

    assert.deepEqual(selectionWeights(nodes, defaultPrefixCap, now), [1, 1, 1, 1]);
  });
});

describe('pickWeightedNode', () => {
  const now = Date.parse('2026-11-04T00:00:00.000Z');
  const nodeAt = (id, host, firstSeen = null) => ({
    id,
    nodeHost: host,
    nodePort: 16000,
    ...(firstSeen ? { status: { firstSeen } } : {}),
  });

  it('returns undefined for an empty list and the only node of a single entry', () => {
    assert.equal(pickWeightedNode([], { now }), undefined);
    assert.equal(pickWeightedNode([nodeAt('a', '192.0.1.1')], { now }).id, 'a');
  });

  it('beats a concentrated Sybil block spread over two prefixes', () => {
    // Reference design: 10 fake nodes in the 198.51.100.0/24 and
    // 203.0.113.0/24 prefixes against 10 real nodes across the eight distinct
    // 192.0.1.0/24 .. 192.0.8.0/24 prefixes. Height does not matter for the
    // pick, so the third octet is varied to keep the real prefixes distinct.
    // Real nodes are established; fakes are first seen now.
    const fake = [];
    for (let index = 0; index < 5; index++) {
      fake.push(nodeAt(`fake-a${index}`, `198.51.100.${index + 1}`));
      fake.push(nodeAt(`fake-b${index}`, `203.0.113.${index + 1}`));
    }

    const real = [];
    for (let index = 0; index < 10; index++) {
      real.push(
        nodeAt(`real-${index}`, `192.0.${(index % 8) + 1}.${index + 1}`, '2026-11-03T22:00:00.000Z')
      );
    }

    const nodes = [...fake, ...real];
    const runs = 1000;
    let fakePicks = 0;

    for (let step = 0; step < runs; step++) {
      const picked = pickWeightedNode(nodes, { now, random: () => (step + 0.5) / runs });
      const prefix = ipv4Prefix(picked.nodeHost);

      if (prefix === '198.51.100' || prefix === '203.0.113') {
        fakePicks++;
      }
    }

    // Fakes hold 2 x 5 = 10 of the 10 + 8 x 5 = 50 selection mass (20%).
    // A raw uniform pick would give them 50%.
    assert.ok(fakePicks / runs < 0.3, `fake picks ${fakePicks} of ${runs}`);
    assert.ok(fakePicks / runs > 0.1, `fake picks ${fakePicks} of ${runs}`);
  });

  it('bounds a single flood prefix even without tenure differences', () => {
    const flood = [];
    for (let index = 0; index < 20; index++) {
      flood.push(nodeAt(`f${index}`, `198.51.100.${index + 1}`));
    }

    const real = [];
    for (let index = 0; index < 10; index++) {
      real.push(nodeAt(`r${index}`, `192.0.${index + 1}.1`));
    }

    const nodes = [...flood, ...real];
    const runs = 900;
    let floodPicks = 0;

    for (let step = 0; step < runs; step++) {
      const picked = pickWeightedNode(nodes, { now, random: () => (step + 0.5) / runs });

      if (ipv4Prefix(picked.nodeHost) === '198.51.100') {
        floodPicks++;
      }
    }

    // The flood prefix holds 5 of 5 + 10 = 15 mass (33%) instead of 67% raw.
    assert.ok(floodPicks / runs < 0.45, `flood picks ${floodPicks} of ${runs}`);
    assert.ok(floodPicks / runs > 0.2, `flood picks ${floodPicks} of ${runs}`);
  });

  it('honours the weighted thresholds at the extremes', () => {
    const nodes = [nodeAt('a', '192.0.1.1', '2026-11-03T22:00:00.000Z'), nodeAt('b', '192.0.2.1')];
    // a weighs 5 (tenure capped per prefix), b weighs 1; total 6.
    assert.equal(pickWeightedNode(nodes, { now, random: () => 0 }).id, 'a');
    assert.equal(pickWeightedNode(nodes, { now, random: () => 0.9 }).id, 'b');
    assert.equal(pickWeightedNode(nodes, { now, random: () => 0.82 }).id, 'a');
  });
});
