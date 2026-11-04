const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAnchorRing } = require('../anchor-ring');
const {
  applyListingUpdate,
  listingKey,
  mustProbe,
  occupantIdForKey,
  preserveProbedChain,
  probeSkipMs,
  syncedNodes,
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
  const hash = (height) => String(height).padStart(64, '0');
  const row = (height, tipHash, reachable = true) => ({
    status: { isReachable: reachable },
    blockchain: tipHash ? { height, tipHash } : { height },
  });
  // ring of the last 20 published tips: heights 2158984..2159003, anchor = 2159003
  const buildRing = () => {
    const ring = createAnchorRing(20);

    for (let height = 2158984; height <= 2159003; height++) {
      ring.push({ height, hash: hash(height) });
    }

    return ring;
  };

  it('keeps reachable rows inside the anchor band when no ring is known yet', () => {
    const rows = [
      row(2159003),
      row(2159001),
      row(2159005),
      row(2159000),
      row(2159006),
      row(2159103),
      row(2159003, undefined, false),
    ];

    assert.deepEqual(
      syncedNodes(rows, true, 2159003).map((rowValue) => rowValue.blockchain.height),
      [2159003, 2159001, 2159005]
    );
  });

  it('returns no synced rows when the seed anchor is missing', () => {
    const rows = [row(2159003)];

    assert.deepEqual(syncedNodes(rows, true, null), []);
    assert.deepEqual(syncedNodes(rows, false, null), rows);
  });

  it('verifies a row whose height and tip hash sit in the ring', () => {
    const ring = buildRing();
    const verified = row(2159001, hash(2159001));

    assert.deepEqual(syncedNodes([verified], true, 2159003, ring), [verified]);
    assert.equal(verified.status.syncedGrace, undefined);
  });

  it('rejects a ring-covered height with a mismatched tip hash', () => {
    const ring = buildRing();

    assert.deepEqual(syncedNodes([row(2159001, hash(2159002))], true, 2159003, ring), []);
  });

  it('rejects a ring-covered height with no tip hash at all', () => {
    const ring = buildRing();

    assert.deepEqual(syncedNodes([row(2159001)], true, 2159003, ring), []);
  });

  it('admits a height above the ring maximum inside the band under grace', () => {
    const ring = buildRing();
    const ahead = row(2159004, hash(2159004));

    assert.deepEqual(syncedNodes([ahead], true, 2159003, ring), [ahead]);
    assert.equal(ahead.status.syncedGrace, true);
  });

  it('keeps the grace window inside the upper bound', () => {
    const ring = buildRing();
    const graceTop = row(2159005, hash(2159005));
    const beyond = row(2159006, hash(2159006));

    assert.deepEqual(syncedNodes([graceTop, beyond], true, 2159003, ring), [graceTop]);
  });

  it('rejects a grace row on hash mismatch once the ring reaches its height', () => {
    const ring = buildRing();
    const grace = row(2159004, hash(2159004));

    assert.deepEqual(syncedNodes([grace], true, 2159003, ring), [grace]);

    // the real chain reached 2159004 with a different hash
    ring.push({ height: 2159004, hash: hash(2159003) });

    assert.deepEqual(syncedNodes([grace], true, 2159003, ring), []);
    assert.equal(grace.status.syncedGrace, undefined);
  });

  it('clears the grace flag once the ring verifies the claimed tip', () => {
    const ring = buildRing();
    const grace = row(2159004, hash(2159004));

    syncedNodes([grace], true, 2159003, ring);
    assert.equal(grace.status.syncedGrace, true);

    ring.push({ height: 2159004, hash: hash(2159004) });
    syncedNodes([grace], true, 2159003, ring);

    assert.equal(grace.status.syncedGrace, undefined);
  });

  it('rejects a row with a non-numeric height inside the band', () => {
    const values = [
      { status: { isReachable: true }, blockchain: {} },
      { status: { isReachable: true } },
    ];

    assert.deepEqual(syncedNodes(values, true, 2159003, buildRing()), []);
    assert.deepEqual(syncedNodes(values, true, 2159003), []);
  });
});
