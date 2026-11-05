const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
  tierNewPerIp,
  trailingRingDepth,
  uptimeMonthsWindow,
  uptimeTicksRequired,
} = require('../admission');

const sampleAdmission = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config.json.sample'), 'utf8')
).admission;

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
    assert.equal(typeof sampleAdmission.tierNewPerIp, 'number');
    assert.equal(tierNewPerIp, sampleAdmission.tierNewPerIp);
    assert.equal(
      resolvePositiveInt(sampleAdmission.tierNewPerIp, trailingRingDepth),
      sampleAdmission.tierNewPerIp
    );
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
  const seat = (id, submitterIp, lastSeen, tier = TIER_NEW, host = '203.0.113.10') =>
    tiered(
      {
        ...ipNode(id, host),
        submitterIp,
        status: { lastSeen },
      },
      tier
    );
  const withCap = (uptimeTicks, cap, maxKeys) => {
    const base = options(uptimeTicks);

    return {
      ...base,
      maxKeys,
      context: { ...base.context, tierNewPerIp: cap },
    };
  };
  const earliest = (rows) =>
    rows.reduce((left, right) =>
      Date.parse(left.lastSeen) <= Date.parse(right.lastSeen) ? left : right
    );

  it('stores a listing below the cap', () => {
    const cache = new NodeCache({ stdTTL: 600, maxKeys: 2 });

    assert.equal(
      admitListing(cache, { ...ipNode('u1'), submitterIp: '203.0.113.10' }, options(0)),
      true
    );
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

    assert.equal(
      admitListing(cache, { ...ipNode('u1'), submitterIp: '203.0.113.11' }, options(0)),
      true
    );
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

    assert.equal(
      admitListing(
        cache,
        { ...ipNode('u-new'), submitterIp: '203.0.113.50' },
        { ...options(0), logger }
      ),
      false
    );
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
    assert.equal(
      admitListing(cache, { ...ipNode('u-new'), submitterIp: '203.0.113.51' }, options(0)),
      false
    );
    assert.equal(cache.keys().sort().join(','), 'b-new,b-old');
  });

  it('treats a cache row without a stored tier as the lowest tier', () => {
    const cache = new NodeCache({ stdTTL: 600, maxKeys: 2 });

    fill(cache, [
      ['legacy', { ...ipNode('legacy'), status: { lastSeen: '2026-01-01T00:00:00.000Z' } }],
      ['seed', seedNode('seed')],
    ]);

    assert.equal(
      admitListing(cache, { ...ipNode('u-new'), submitterIp: '203.0.113.52' }, options(0)),
      true
    );
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

  it('replaces that IP oldest tier-C when another tier-C exceeds the per-IP cap', () => {
    const ip = '198.51.100.10';
    const otherIp = '198.51.100.20';
    const sameIp = [
      { id: 'same-older', lastSeen: '2026-02-02T00:00:00.000Z' },
      { id: 'same-newer', lastSeen: '2026-02-04T00:00:00.000Z' },
    ];
    const other = { id: 'other-older', lastSeen: '2026-02-01T00:00:00.000Z' };
    const occupants = [...sameIp, other];
    const cap = sameIp.length;
    const cache = new NodeCache({ stdTTL: 600, maxKeys: occupants.length });

    fill(cache, [
      ...sameIp.map((row) => [row.id, seat(row.id, ip, row.lastSeen)]),
      [other.id, seat(other.id, otherIp, other.lastSeen)],
    ]);

    const incoming = { ...ipNode('same-third'), submitterIp: ip };
    const oldest = earliest(sameIp);

    assert.equal(admitListing(cache, incoming, withCap(0, cap, occupants.length)), true);
    assert.equal(cache.has(oldest.id), false);
    assert.equal(cache.has(sameIp.find((row) => row.id !== oldest.id).id), true);
    assert.equal(cache.has(other.id), true);
    assert.equal(cache.has(incoming.id), true);
    assert.equal(cache.get(incoming.id).admissionTier, TIER_NEW);
  });

  it('refreshes a tier-C id without dropping another seat from that IP', () => {
    const ip = '198.51.100.11';
    const seats = [
      { id: 'seat-older', lastSeen: '2026-04-01T00:00:00.000Z' },
      { id: 'seat-newer', lastSeen: '2026-04-02T00:00:00.000Z' },
    ];
    const cap = seats.length;
    const cache = new NodeCache({ stdTTL: 600, maxKeys: seats.length });

    fill(
      cache,
      seats.map((row) => [row.id, seat(row.id, ip, row.lastSeen)])
    );

    const refreshed = seats[seats.length - 1];
    const incoming = {
      ...ipNode(refreshed.id),
      submitterIp: ip,
      status: { lastSeen: '2026-04-03T00:00:00.000Z' },
    };

    assert.equal(admitListing(cache, incoming, withCap(0, cap, seats.length)), true);

    for (const row of seats) {
      assert.equal(cache.has(row.id), true);
    }

    assert.equal(cache.keys().length, seats.length);
  });

  it('admits a seed from an IP already at the tier-C cap and keeps those rows', () => {
    const ip = '198.51.100.31';
    const tierC = [
      { id: 'seed-cap-a', lastSeen: '2026-05-02T00:00:00.000Z' },
      { id: 'seed-cap-b', lastSeen: '2026-05-03T00:00:00.000Z' },
    ];
    const cap = tierC.length;
    const room = tierC.length + 1;
    const cache = new NodeCache({ stdTTL: 600, maxKeys: room });

    fill(
      cache,
      tierC.map((row) => [row.id, seat(row.id, ip, row.lastSeen)])
    );

    const incoming = { ...seedNode('seed-extra'), submitterIp: ip };

    assert.equal(admitListing(cache, incoming, withCap(0, cap, room)), true);

    for (const row of tierC) {
      assert.equal(cache.has(row.id), true);
    }

    assert.equal(cache.has(incoming.id), true);
    assert.equal(cache.get(incoming.id).admissionTier, TIER_SEED);
  });

  it('admits an uptime listing from an IP already at the tier-C cap and keeps those rows', () => {
    const ip = '198.51.100.32';
    const tierC = [
      { id: 'uptime-cap-a', lastSeen: '2026-05-02T00:00:00.000Z' },
      { id: 'uptime-cap-b', lastSeen: '2026-05-03T00:00:00.000Z' },
    ];
    const cap = tierC.length;
    const room = tierC.length + 1;
    const requiredTicks = options(0).context.ticksRequired;
    const cache = new NodeCache({ stdTTL: 600, maxKeys: room });

    fill(
      cache,
      tierC.map((row) => [row.id, seat(row.id, ip, row.lastSeen)])
    );

    const incoming = { ...ipNode('uptime-extra'), submitterIp: ip };

    assert.equal(admitListing(cache, incoming, withCap(requiredTicks, cap, room)), true);

    for (const row of tierC) {
      assert.equal(cache.has(row.id), true);
    }

    assert.equal(cache.has(incoming.id), true);
    assert.equal(cache.get(incoming.id).admissionTier, TIER_UPTIME);
  });

  it('does not count a seed or uptime row toward the per-IP tier-C cap', () => {
    const ip = '198.51.100.33';
    const tierC = [
      { id: 'only-c-older', lastSeen: '2026-05-02T00:00:00.000Z' },
      { id: 'only-c-newer', lastSeen: '2026-05-03T00:00:00.000Z' },
    ];
    const extras = [
      {
        id: 'seed-row',
        lastSeen: '2026-05-01T00:00:00.000Z',
        tier: TIER_SEED,
        host: 'seed1.conceal.network',
      },
      {
        id: 'uptime-row',
        lastSeen: '2026-05-01T00:00:00.000Z',
        tier: TIER_UPTIME,
        host: '203.0.113.33',
      },
    ];
    const kept = [...tierC, ...extras];
    const cap = tierC.length + extras.length;
    const room = kept.length + 1;
    const cache = new NodeCache({ stdTTL: 600, maxKeys: room });

    fill(
      cache,
      kept.map((row) => [row.id, seat(row.id, ip, row.lastSeen, row.tier, row.host)])
    );

    const incoming = { ...ipNode('c-next'), submitterIp: ip };

    assert.equal(admitListing(cache, incoming, withCap(0, cap, room)), true);

    for (const row of kept) {
      assert.equal(cache.has(row.id), true);
    }

    assert.equal(cache.has(incoming.id), true);
    assert.equal(cache.keys().length, kept.length + 1);
  });

  it('drops the oldest tier-C from that IP and leaves an older seed and uptime row', () => {
    const ip = '198.51.100.40';
    const tierC = [
      { id: 'c-older', lastSeen: '2026-06-02T00:00:00.000Z' },
      { id: 'c-newer', lastSeen: '2026-06-04T00:00:00.000Z' },
    ];
    const protectedRows = [
      {
        id: 'uptime-older',
        lastSeen: '2026-06-01T00:00:00.000Z',
        tier: TIER_UPTIME,
        host: '203.0.113.40',
      },
      {
        id: 'seed-older',
        lastSeen: '2026-05-01T00:00:00.000Z',
        tier: TIER_SEED,
        host: 'seed1.conceal.network',
      },
    ];
    const cap = tierC.length;
    const occupants = [...tierC, ...protectedRows];
    const room = occupants.length + 1;
    const cache = new NodeCache({ stdTTL: 600, maxKeys: room });

    fill(
      cache,
      occupants.map((row) => [row.id, seat(row.id, ip, row.lastSeen, row.tier, row.host)])
    );

    const incoming = { ...ipNode('c-third'), submitterIp: ip };
    const oldest = earliest(tierC);

    assert.equal(admitListing(cache, incoming, withCap(0, cap, room)), true);
    assert.equal(cache.has(oldest.id), false);

    for (const row of tierC) {
      if (row.id !== oldest.id) {
        assert.equal(cache.has(row.id), true);
      }
    }

    for (const row of protectedRows) {
      assert.equal(cache.has(row.id), true);
    }

    assert.equal(cache.has(incoming.id), true);
  });

  it('refuses a tier-C id that claims a higher tier host:port and frees no seat', () => {
    const ip = '198.51.100.60';
    const cap = 2;
    const tierC = [
      { id: 'c-older', lastSeen: '2026-06-02T00:00:00.000Z', host: '203.0.113.61' },
      { id: 'c-newer', lastSeen: '2026-06-04T00:00:00.000Z', host: '203.0.113.62' },
    ];
    const protectedRows = [
      {
        id: 'uptime-held',
        lastSeen: '2026-06-01T00:00:00.000Z',
        tier: TIER_UPTIME,
        host: '203.0.113.70',
      },
      {
        id: 'seed-held',
        lastSeen: '2026-05-01T00:00:00.000Z',
        tier: TIER_SEED,
        host: 'seed1.conceal.network',
      },
    ];
    const occupants = [...tierC, ...protectedRows];
    const cache = new NodeCache({ stdTTL: 600, maxKeys: occupants.length });

    fill(
      cache,
      occupants.map((row) => [row.id, seat(row.id, ip, row.lastSeen, row.tier, row.host)])
    );

    const takeover = {
      ...ipNode('c-takeover', '203.0.113.70'),
      submitterIp: ip,
    };

    assert.equal(
      admitListing(cache, takeover, {
        ...withCap(0, cap, occupants.length),
        occupantId: 'uptime-held',
      }),
      false
    );

    for (const row of occupants) {
      assert.equal(cache.has(row.id), true);
    }

    assert.equal(cache.has(takeover.id), false);
    assert.equal(cache.has('seed-held'), true);
  });

  it('replaces an equal-tier occupant and still refuses another seed id', () => {
    const cache = new NodeCache({ stdTTL: 600, maxKeys: 2 });
    const held = seat(
      'c-held',
      '198.51.100.70',
      '2026-06-01T00:00:00.000Z',
      TIER_NEW,
      '203.0.113.71'
    );
    const incoming = {
      ...ipNode('c-next', '203.0.113.71'),
      submitterIp: '198.51.100.71',
    };

    cache.set(held.id, held);

    assert.equal(admitListing(cache, incoming, { ...withCap(0, 2, 2), occupantId: held.id }), true);
    assert.equal(cache.has(held.id), false);
    assert.equal(cache.has(incoming.id), true);
    assert.equal(cache.get(incoming.id).admissionTier, TIER_NEW);

    const seedCache = new NodeCache({ stdTTL: 600, maxKeys: 2 });
    const seedHeld = seat(
      'seed-held',
      '198.51.100.1',
      '2026-06-01T00:00:00.000Z',
      TIER_SEED,
      'seed1.conceal.network'
    );
    const otherSeed = seedNode('seed-other');

    seedCache.set(seedHeld.id, seedHeld);

    assert.equal(
      admitListing(seedCache, otherSeed, { ...options(0), occupantId: seedHeld.id }),
      false
    );
    assert.equal(seedCache.has(seedHeld.id), true);
    assert.equal(seedCache.has(otherSeed.id), false);
  });

  it('rejects a tier-C listing with a missing or empty submitter IP', () => {
    const cap = 1;
    const room = cap + 1;
    const cache = new NodeCache({ stdTTL: 600, maxKeys: room });
    const missing = ipNode('missing-ip');
    const empty = { ...ipNode('empty-ip'), submitterIp: '' };

    assert.equal(admitListing(cache, missing, withCap(0, cap, room)), false);
    assert.equal(cache.has(missing.id), false);
    assert.equal(admitListing(cache, empty, withCap(0, cap, room)), false);
    assert.equal(cache.has(empty.id), false);
  });

  it('falls back to the resolved per-IP cap when the option is not a positive integer', () => {
    assert.equal(typeof sampleAdmission.tierNewPerIp, 'number');

    const cap = sampleAdmission.tierNewPerIp;
    const underCount = cap - 1;

    assert.equal(tierNewPerIp, cap);
    assert.ok(underCount >= 1);

    const ip = '198.51.100.50';
    const rows = Array.from({ length: cap }, (_, index) => ({
      id: `fallback-${index}`,
      lastSeen: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    }));
    const oldest = rows[0];
    const newest = rows[rows.length - 1];
    const room = rows.length + 1;
    const cache = new NodeCache({ stdTTL: 600, maxKeys: room });

    fill(
      cache,
      rows.map((row) => [row.id, seat(row.id, ip, row.lastSeen)])
    );

    const incoming = { ...ipNode('fallback-extra'), submitterIp: ip };

    assert.equal(admitListing(cache, incoming, withCap(0, 0, room)), true);
    assert.equal(cache.has(oldest.id), false);
    assert.equal(cache.has(newest.id), true);
    assert.equal(cache.has(incoming.id), true);

    const under = rows.slice(0, underCount);
    const underCache = new NodeCache({ stdTTL: 600, maxKeys: room });

    fill(
      underCache,
      under.map((row) => [row.id, seat(row.id, ip, row.lastSeen)])
    );

    const second = { ...ipNode('fallback-under'), submitterIp: ip };

    assert.equal(admitListing(underCache, second, withCap(0, 'nope', room)), true);

    for (const row of under) {
      assert.equal(underCache.has(row.id), true);
    }

    assert.equal(underCache.has(second.id), true);
  });
});

describe('tier-C per-IP cap wiring', () => {
  it('passes the resolved cap into admitListing', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const start = source.indexOf('admitListing(nodeCache');
    const call = source.slice(start, source.indexOf(');', start));

    assert.match(call, /context:\s*\{[^}]*\btierNewPerIp\b/);
  });
});
