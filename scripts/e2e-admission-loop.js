const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const NodeCache = require('node-cache');
const { createAnchorRing } = require('../anchor-ring');
const { TIER_NEW, TIER_SEED, TIER_UPTIME, admitListing, tierNewPerIp } = require('../admission');
const { anchorBandHalf, applyChainGate } = require('../listing-policy');

const hashFor = (label) => crypto.createHash('sha256').update(label).digest('hex');

const anchor = 4_000_000;
const coveredHeight = anchor;
const ring = createAnchorRing(20);
const coveredHash = hashFor(`covered-${coveredHeight}`);
const priorHash = hashFor(`prior-${coveredHeight - 1}`);

ring.push({ height: coveredHeight - 1, hash: priorHash });
ring.push({ height: coveredHeight, hash: coveredHash });

const published = ring.entries().find((entry) => entry.height === coveredHeight);
const missHash = hashFor(`miss-${coveredHeight}`);
const rejectedId = 'covered-miss';
const keptId = 'other-occupant';
const keptMarker = hashFor('kept-occupant');

assert.ok(published);
assert.equal(published.hash, coveredHash);
assert.notEqual(missHash, published.hash);
assert.equal(ring.maxHeight(), coveredHeight);
assert.ok(coveredHeight >= anchor - anchorBandHalf && coveredHeight <= anchor + anchorBandHalf);
assert.notEqual(rejectedId, keptId);

const chainCache = new NodeCache({ stdTTL: 600, maxKeys: 10 });

chainCache.set(rejectedId, {
  id: rejectedId,
  blockchain: { height: coveredHeight, tipHash: coveredHash },
});
chainCache.set(keptId, { id: keptId, marker: keptMarker });
assert.equal(chainCache.getStats().keys, 2);

const missed = {
  id: rejectedId,
  status: { syncedGrace: true, isReachable: true },
  blockchain: { height: coveredHeight, tipHash: missHash },
};
const gate = applyChainGate(chainCache, missed, anchor, ring);

assert.deepEqual(gate, { ok: false, verdict: 'reject' });
assert.equal(chainCache.has(rejectedId), false);
assert.equal(chainCache.has(keptId), true);
assert.equal(chainCache.get(keptId).marker, keptMarker);
assert.equal(missed.status.syncedGrace, undefined);

const syncingId = 'syncing-node';
const syncingHeight = anchor - 50;

chainCache.set(syncingId, {
  id: syncingId,
  blockchain: { height: syncingHeight, tipHash: hashFor(`syncing-${syncingHeight}`) },
});

const syncing = {
  id: syncingId,
  status: { isReachable: true },
  blockchain: { height: syncingHeight, tipHash: hashFor(`syncing-${syncingHeight}`) },
};
const syncGate = applyChainGate(chainCache, syncing, anchor, ring);

assert.deepEqual(syncGate, { ok: true, verdict: 'reject' });
assert.equal(chainCache.has(syncingId), true);
assert.equal(chainCache.has(keptId), true);
assert.equal(chainCache.has(rejectedId), false);

const sameIp = '198.51.100.10';
const otherIp = '198.51.100.99';
const cap = tierNewPerIp;

assert.ok(cap >= 2);
assert.notEqual(sameIp, otherIp);

const sameSeats = Array.from({ length: cap }, (_, index) => {
  const lastSeenMs = Date.UTC(2026, 3, index + 2);

  return {
    id: `same-${index}`,
    host: `203.0.113.${20 + index}`,
    lastSeenMs,
    lastSeen: new Date(lastSeenMs).toISOString(),
  };
});
const oldest = sameSeats.reduce(
  (left, right) => (left.lastSeenMs < right.lastSeenMs ? left : right),
  sameSeats[0]
);
const keptSeats = sameSeats.filter((seat) => seat.id !== oldest.id);
const keptSeat = keptSeats[0];
const otherLastSeenMs = Date.UTC(2026, 0, 1);
const otherLastSeen = new Date(otherLastSeenMs).toISOString();
const otherId = 'other-ip';

assert.ok(keptSeat);
assert.notEqual(oldest.lastSeen, keptSeat.lastSeen);
assert.ok(otherLastSeenMs < oldest.lastSeenMs);
assert.notEqual(otherId, oldest.id);

const room = sameSeats.length + 2;
const ipCache = new NodeCache({ stdTTL: 600, maxKeys: room });
const row = (id, submitterIp, host, lastSeen) => ({
  id,
  nodeHost: host,
  nodePort: 16000,
  submitterIp,
  admissionTier: TIER_NEW,
  status: { lastSeen },
});

for (const seat of sameSeats) {
  ipCache.set(seat.id, row(seat.id, sameIp, seat.host, seat.lastSeen));
}

ipCache.set(otherId, row(otherId, otherIp, '203.0.113.90', otherLastSeen));
assert.equal(ipCache.getStats().keys, cap + 1);

const incoming = {
  id: 'same-incoming',
  nodeHost: '203.0.113.80',
  nodePort: 16000,
  submitterIp: sameIp,
  status: { lastSeen: new Date(Date.UTC(2026, 4, 1)).toISOString() },
};

assert.equal(
  admitListing(ipCache, incoming, {
    ttl: 600,
    maxKeys: room,
    logger: { warn() {} },
    context: { uptimeTicks: 0, ticksRequired: 4320 },
  }),
  true
);
assert.equal(ipCache.has(oldest.id), false);

for (const seat of keptSeats) {
  assert.equal(ipCache.has(seat.id), true);
  assert.equal(ipCache.get(seat.id).status.lastSeen, seat.lastSeen);
  assert.equal(ipCache.get(seat.id).submitterIp, sameIp);
  assert.notEqual(seat.lastSeen, oldest.lastSeen);
}
assert.equal(ipCache.has(otherId), true);
assert.equal(ipCache.get(otherId).submitterIp, otherIp);
assert.equal(ipCache.get(otherId).status.lastSeen, otherLastSeen);
assert.equal(ipCache.has(incoming.id), true);
assert.equal(ipCache.get(incoming.id).admissionTier, TIER_NEW);
assert.equal(ipCache.getStats().keys, cap + 1);

const protectedCache = new NodeCache({ stdTTL: 600, maxKeys: 2 });
const protectedSeen = new Date(Date.UTC(2026, 0, 1)).toISOString();

protectedCache.set('seed-row', {
  id: 'seed-row',
  nodeHost: 'seed1.conceal.network',
  nodePort: 16000,
  admissionTier: TIER_SEED,
  status: { lastSeen: protectedSeen },
});
protectedCache.set('uptime-row', {
  id: 'uptime-row',
  nodeHost: '203.0.113.40',
  nodePort: 16000,
  admissionTier: TIER_UPTIME,
  submitterIp: otherIp,
  status: { lastSeen: protectedSeen },
});

const takeover = {
  id: 'tier-c-takeover',
  nodeHost: '203.0.113.40',
  nodePort: 16000,
  submitterIp: sameIp,
  status: { lastSeen: new Date(Date.UTC(2026, 4, 2)).toISOString() },
};

assert.equal(
  admitListing(protectedCache, takeover, {
    ttl: 600,
    maxKeys: 2,
    logger: { warn() {} },
    occupantId: 'uptime-row',
    context: { uptimeTicks: 0, ticksRequired: 4320 },
  }),
  false
);
assert.equal(protectedCache.has('uptime-row'), true);
assert.equal(protectedCache.has('seed-row'), true);
assert.equal(protectedCache.has(takeover.id), false);
assert.equal(protectedCache.get('uptime-row').admissionTier, TIER_UPTIME);
assert.equal(protectedCache.get('seed-row').admissionTier, TIER_SEED);

console.log('E2E_ADMISSION_OK');
