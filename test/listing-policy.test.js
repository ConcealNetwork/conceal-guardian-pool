const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  applyListingUpdate,
  listingKey,
  mustProbe,
  occupantIdForKey,
  preserveProbedChain,
  reachableMajorityHeight,
  syncedNodes,
} = require('../listing-policy');

const probeSkipMs = 15 * 60 * 1000;

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

  it('skips when the same key was probed inside 15 minutes', () => {
    const existing = ipNode('u1');
    assert.equal(mustProbe(existing, data, now - 60 * 1000, now), false);
  });

  it('probes when the last probe is older than 15 minutes', () => {
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
});

describe('synced filter', () => {
  it('computes majority height from reachable rows only', () => {
    const rows = [
      { status: { isReachable: true }, blockchain: { height: 2159003 } },
      { status: { isReachable: true }, blockchain: { height: 2159003 } },
      { status: { isReachable: false }, blockchain: { height: 2159103 } },
    ];

    const majority = reachableMajorityHeight(rows);
    const reachable = rows.filter((row) => row.status.isReachable);
    const expected = reachable[0].blockchain.height;

    assert.equal(majority, expected);
    assert.deepEqual(
      syncedNodes(rows, true).map((row) => row.blockchain.height),
      [expected, expected]
    );
  });
});
