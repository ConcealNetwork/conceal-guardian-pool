const assert = require('node:assert/strict');
const {
  applyListingUpdate,
  listingKey,
  occupantIdForKey,
  preserveProbedChain,
} = require('../listing-policy');

const cache = new Map();

const commit = (record, existing, reachable, allowEvict) => {
  const result = applyListingUpdate({
    data: record,
    existing,
    reachable,
    occupantId: allowEvict
      ? occupantIdForKey([...cache.values()], listingKey(record), record.id)
      : undefined,
  });

  if (!result.ok) {
    return result;
  }

  if (result.evictId) {
    cache.delete(result.evictId);
  }

  cache.set(result.store.id, result.store);
  return result;
};

const oldId = '11111111-1111-4111-8111-111111111111';
const newId = '22222222-2222-4222-8222-222222222222';
const live = {
  id: oldId,
  nodeHost: '203.0.113.10',
  nodePort: 16000,
  blockchain: { height: 2159003, fee_address: '', status: 'OK' },
  status: { isReachable: true },
};

assert.equal(commit(live, null, false, true).reason, 'new-unreachable');
assert.equal(cache.size, 0);

assert.equal(commit(live, null, true, true).ok, true);
assert.equal(cache.has(oldId), true);

const moveDead = {
  ...live,
  nodeHost: '198.51.100.7',
};
assert.equal(commit(moveDead, cache.get(oldId), false, true).reason, 'move-unreachable');
assert.equal(listingKey(cache.get(oldId)), listingKey(live));

const thief = {
  id: newId,
  nodeHost: live.nodeHost,
  nodePort: live.nodePort,
  blockchain: { height: 100, status: 'OK' },
  status: { isReachable: false },
};
assert.equal(commit(thief, null, false, true).reason, 'new-unreachable');
assert.equal(cache.has(oldId), true);
assert.equal(cache.has(newId), false);

assert.equal(commit({ ...thief, status: { isReachable: true } }, null, true, true).ok, true);
assert.equal(cache.has(oldId), false);
assert.equal(cache.has(newId), true);

const existingHeight = cache.get(newId).blockchain.height;
const skipLie = {
  id: newId,
  nodeHost: live.nodeHost,
  nodePort: live.nodePort,
  blockchain: { height: 12, fee_address: 'ccx7fake', status: 'LIE' },
  status: { isReachable: true },
};
const frozen = preserveProbedChain(skipLie, cache.get(newId));
assert.notEqual(12, existingHeight);
assert.equal(frozen.blockchain.height, existingHeight);

console.log('E2E_LISTING_GATE_OK');
