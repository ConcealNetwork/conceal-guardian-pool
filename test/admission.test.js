const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const NodeCache = require('node-cache');

const {
  TIER_NEW,
  TIER_SEED,
  TIER_UPTIME,
  admitListing,
  pickEviction,
  probeHostName,
  resolvePositiveInt,
  resolveTier,
  seedHosts,
  trailingRingDepth,
  uptimeMonthsWindow,
  uptimeTicksRequired,
} = require('../admission');

const silent = { warn() {} };

const seedNode = (id, host = 'seed1.conceal.network') => ({
  id,
  nodeHost: host,
  nodePort: 16000,
});
const ipNode = (id, host = '203.0.113.10') => ({ id, nodeHost: host, nodePort: 16000 });
const context = {
  seedHosts: new Set(['seed1.conceal.network']),
  uptimeTicks: 0,
  ticksRequired: 4320,
};

describe('resolvePositiveInt', () => {
  it('falls back to the default for invalid config values', () => {
    assert.equal(resolvePositiveInt(undefined, 30), 30);
    assert.equal(resolvePositiveInt(null, 30), 30);
    assert.equal(resolvePositiveInt('abc', 30), 30);
    assert.equal(resolvePositiveInt(0, 30), 30);
    assert.equal(resolvePositiveInt(-3, 30), 30);
    assert.equal(resolvePositiveInt(2.9, 30), 2);
    assert.equal(resolvePositiveInt('45', 30), 45);
    assert.equal(resolvePositiveInt(500, 30), 500);
  });

  it('keeps the shipped defaults on the sample config', () => {
    assert.equal(trailingRingDepth, 20);
    assert.equal(uptimeTicksRequired, 3 * 1440);
    assert.ok(uptimeMonthsWindow >= 1);
  });
});

describe('resolveTier', () => {
  it('tiers a seed-hosted node first even with zero uptime (database-refresh edge)', () => {
    assert.equal(resolveTier(seedNode('u1'), context), TIER_SEED);
    assert.equal(resolveTier(seedNode('u1'), { ...context, uptimeTicks: 0 }), TIER_SEED);
  });

  it('tiers a domain-url probe target by its seed hostname', () => {
    const node = {
      id: 'u2',
      nodeHost: '203.0.113.9',
      nodePort: 16000,
      url: { host: 'SEED1.conceal.network/daemon', port: '' },
    };

    assert.equal(resolveTier(node, context), TIER_SEED);
  });

  it('tiers by recent uptime when the probe host is not a seed', () => {
    assert.equal(resolveTier(ipNode('u3'), { ...context, uptimeTicks: 4320 }), TIER_UPTIME);
    assert.equal(resolveTier(ipNode('u3'), { ...context, uptimeTicks: 4319 }), TIER_NEW);
  });

  it('tiers a node without uptime history as new', () => {
    assert.equal(resolveTier(ipNode('u4'), context), TIER_NEW);
  });

  it('matches against the configured seed host set when no context is given', () => {
    assert.ok(seedHosts.has('seed1.conceal.network'));
    assert.equal(resolveTier(seedNode('u5')), TIER_SEED);
    assert.equal(resolveTier(ipNode('u6')), TIER_NEW);
  });
});

describe('probeHostName', () => {
  it('lowercases the probe host and strips any path suffix', () => {
    assert.equal(probeHostName(ipNode('u1', '203.0.113.10')), '203.0.113.10');
    assert.equal(
      probeHostName({
        id: 'u1',
        nodeHost: '203.0.113.10',
        nodePort: 16000,
        url: { host: 'Seed1.Conceal.Network/daemon', port: '' },
      }),
      'seed1.conceal.network'
    );
    assert.equal(probeHostName({ id: 'u1' }), '');
  });
});

describe('pickEviction', () => {
  const row = (id, tier, lastSeenMs) => ({ id, tier, lastSeenMs });

  it('evicts the lowest tier first, least-recently-seen within the tier', () => {
    const rows = [
      row('seed', TIER_SEED, 0),
      row('b-old', TIER_UPTIME, 100),
      row('c-old', TIER_NEW, 200),
      row('c-new', TIER_NEW, 300),
    ];

    assert.equal(pickEviction(rows, TIER_SEED).id, 'c-old');
  });

  it('falls through to the uptime tier when no tier-C row exists', () => {
    const rows = [
      row('seed', TIER_SEED, 0),
      row('b-old', TIER_UPTIME, 100),
      row('b-new', TIER_UPTIME, 200),
    ];

    assert.equal(pickEviction(rows, TIER_SEED).id, 'b-old');
  });

  it('never evicts a seed-hosted row', () => {
    assert.equal(pickEviction([row('seed', TIER_SEED, 0)], TIER_SEED), null);
  });

  it('an incoming tier-C row evicts only another tier-C row', () => {
    const rows = [row('b1', TIER_UPTIME, 100), row('c1', TIER_NEW, 100)];

    assert.equal(pickEviction(rows, TIER_NEW).id, 'c1');
  });

  it('an incoming tier-C row cannot evict a higher-tier row', () => {
    assert.equal(pickEviction([row('b1', TIER_UPTIME, 100)], TIER_NEW), null);
  });

  it('an incoming tier-B row evicts the least-recently-seen uptime row', () => {
    const rows = [row('b-old', TIER_UPTIME, 50), row('b-new', TIER_UPTIME, 80)];

    assert.equal(pickEviction(rows, TIER_UPTIME).id, 'b-old');
  });
});

describe('admitListing', () => {
  const options = (uptimeTicks) => ({
    ttl: 600,
    maxKeys: 2,
    logger: silent,
    context: { seedHosts: new Set(['seed1.conceal.network']), uptimeTicks, ticksRequired: 4320 },
  });
  const tiered = (node, tier) => ({ ...node, admissionTier: tier });
  const fill = (cache, rows) => {
    rows.forEach(([id, node]) => {
      cache.set(id, node);
    });
  };

  it('stores a listing below the cap', () => {
    const cache = new NodeCache({ stdTTL: 600, maxKeys: 2 });

    assert.equal(admitListing(cache, ipNode('u1'), options(0)), true);
    assert.ok(cache.has('u1'));
    assert.equal(cache.get('u1').admissionTier, TIER_NEW);
  });

  it('stores an uptime-backed listing with its earned tier', () => {
    const cache = new NodeCache({ stdTTL: 600, maxKeys: 2 });

    assert.equal(admitListing(cache, ipNode('u1'), options(4320)), true);
    assert.equal(cache.get('u1').admissionTier, TIER_UPTIME);
  });

  it('stores a seed-hosted listing as the top tier at zero uptime', () => {
    const cache = new NodeCache({ stdTTL: 600, maxKeys: 2 });

    assert.equal(admitListing(cache, seedNode('u1'), options(0)), true);
    assert.equal(cache.get('u1').admissionTier, TIER_SEED);
  });

  it('refreshes an existing id at the cap', () => {
    const cache = new NodeCache({ stdTTL: 600, maxKeys: 2 });

    fill(cache, [
      ['u1', ipNode('u1')],
      ['u2', ipNode('u2')],
    ]);

    assert.equal(admitListing(cache, ipNode('u1'), options(0)), true);
    assert.equal(cache.keys().sort().join(','), 'u1,u2');
  });

  it('evicts the least-recently-seen tier-C row for an incoming tier-B row', () => {
    const cache = new NodeCache({ stdTTL: 600, maxKeys: 2 });
    const old = tiered(
      { ...ipNode('c-old'), status: { lastSeen: '2026-01-01T00:00:00.000Z' } },
      TIER_NEW
    );
    const fresh = tiered(
      { ...ipNode('c-new'), status: { lastSeen: '2026-01-02T00:00:00.000Z' } },
      TIER_NEW
    );

    fill(cache, [
      ['c-old', old],
      ['c-new', fresh],
    ]);

    assert.equal(admitListing(cache, ipNode('u-b'), options(4320)), true);
    assert.ok(cache.has('u-b'));
    assert.ok(cache.has('c-new'));
    assert.equal(cache.has('c-old'), false);
    assert.equal(cache.get('u-b').admissionTier, TIER_UPTIME);
  });

  it('evicts a tier-C row for an incoming seed-hosted row', () => {
    const cache = new NodeCache({ stdTTL: 600, maxKeys: 2 });
    const held = tiered(
      { ...ipNode('c-old'), status: { lastSeen: '2026-01-01T00:00:00.000Z' } },
      TIER_NEW
    );
    const other = tiered(
      { ...ipNode('c-new'), status: { lastSeen: '2026-01-02T00:00:00.000Z' } },
      TIER_NEW
    );

    fill(cache, [
      ['c-old', held],
      ['c-new', other],
    ]);

    assert.equal(admitListing(cache, seedNode('u-seed'), options(0)), true);
    assert.ok(cache.has('u-seed'));
    assert.ok(cache.has('c-new'));
    assert.equal(cache.get('u-seed').admissionTier, TIER_SEED);
  });

  it('rejects an incoming tier-C row when a full cache holds only higher tiers', () => {
    const warnings = [];
    const logger = { warn: (message, fields) => warnings.push({ message, fields }) };
    const cache = new NodeCache({ stdTTL: 600, maxKeys: 2 });

    fill(cache, [
      ['seed', seedNode('seed')],
      ['u-b', tiered(ipNode('u-b'), TIER_UPTIME)],
    ]);

    assert.equal(admitListing(cache, ipNode('u-new'), { ...options(0), logger }), false);
    assert.equal(cache.keys().sort().join(','), 'seed,u-b');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].fields.nodeId, 'u-new');
  });

  it('tiers cache rows by their own stored tier, not the submitter uptime', () => {
    const cache = new NodeCache({ stdTTL: 600, maxKeys: 2 });
    const old = tiered(
      { ...ipNode('b-old'), status: { lastSeen: '2026-01-01T00:00:00.000Z' } },
      TIER_UPTIME
    );
    const fresh = tiered(
      { ...ipNode('b-new'), status: { lastSeen: '2026-01-02T00:00:00.000Z' } },
      TIER_UPTIME
    );

    fill(cache, [
      ['b-old', old],
      ['b-new', fresh],
    ]);

    // the submitter has no uptime history, so its own tier is C and the B rows hold
    assert.equal(admitListing(cache, ipNode('u-new'), options(0)), false);
    assert.equal(cache.keys().sort().join(','), 'b-new,b-old');
  });

  it('treats a cache row without a stored tier as the lowest tier', () => {
    const cache = new NodeCache({ stdTTL: 600, maxKeys: 2 });

    fill(cache, [
      ['legacy', { ...ipNode('legacy'), status: { lastSeen: '2026-01-01T00:00:00.000Z' } }],
      ['seed', seedNode('seed')],
    ]);

    assert.equal(admitListing(cache, ipNode('u-new'), options(0)), true);
    assert.ok(cache.has('u-new'));
    assert.ok(cache.has('seed'));
    assert.equal(cache.has('legacy'), false);
  });

  it('rejects a record without an id', () => {
    const cache = new NodeCache({ stdTTL: 600, maxKeys: 2 });

    assert.equal(admitListing(cache, null, options(0)), false);
    assert.equal(
      admitListing(cache, { nodeHost: '203.0.113.10', nodePort: 16000 }, options(0)),
      false
    );
  });
});
