// Copyright (c) 2019 -2026, Acktarius, The Conceal Developers
//
// Please see the included LICENSE file for more information.

const config = require('./config.json');
const { resolveProbeTarget } = require('./probe.js');
const { storeListing } = require('./listing-cache.js');

const resolvePositiveInt = (value, fallback) => {
  const parsed = Math.floor(Number(value));

  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
};

// admission knobs; invalid config values fall back to the code defaults
const trailingRingDepth = resolvePositiveInt(config.admission?.trailingRingDepth, 20);
const uptimeThresholdDays = resolvePositiveInt(config.admission?.uptimeThresholdDays, 3);
const uptimePeriodSeconds = resolvePositiveInt(config.uptime?.period, 60);

// 60 s ticks -> 1440 per day -> 4320 ticks for the 3-day default threshold
const uptimeTicksRequired = (uptimeThresholdDays * 24 * 60 * 60) / uptimePeriodSeconds;

// how many recent calendar months of uptime history count toward the threshold;
// the recency bound is intentional: old ticks must not earn a tier forever
const uptimeMonthsWindow = Math.max(1, Math.ceil(uptimeThresholdDays / 30) + 1);

// Tier A: probe host is a configured seed — DB-independent, survives a database
// refresh, never evicted in favor of a lower tier.
const TIER_SEED = 1;
// Tier B: enough recent uptime history even when the node is not seed-hosted.
const TIER_UPTIME = 2;
// Tier C: everything else.
const TIER_NEW = 3;

const seedHosts = new Set(
  (Array.isArray(config.seeds) ? config.seeds : [])
    .map((seed) => (seed && typeof seed.host === 'string' ? seed.host.toLowerCase() : ''))
    .filter((host) => host !== '')
);

// probe target hostname without any path suffix, lowercased
const probeHostName = (record) => {
  const { host } = resolveProbeTarget(record);

  if (typeof host !== 'string' || host === '') {
    return '';
  }

  const slash = host.indexOf('/');
  const hostname = slash === -1 ? host : host.slice(0, slash);

  return hostname.replace(/^\[|]$/g, '').toLowerCase();
};

const resolveTier = (record, context = {}) => {
  const host = probeHostName(record);
  const hosts = context.seedHosts instanceof Set ? context.seedHosts : seedHosts;

  if (host !== '' && hosts.has(host)) {
    return TIER_SEED;
  }

  const ticks = Number(context.uptimeTicks ?? 0);
  const required = Number(context.ticksRequired ?? uptimeTicksRequired);

  if (required > 0 && Number.isFinite(ticks) && ticks >= required) {
    return TIER_UPTIME;
  }

  return TIER_NEW;
};

// victim selection at a full cache: evict the lowest tier first, least-recently-seen
// within the tier. Seed-hosted rows are never eviction candidates, and an incoming
// listing may never evict a row that holds a higher tier than its own.
const pickEviction = (rows, incomingTier) => {
  const candidates = rows.filter(
    (row) => row && typeof row.id === 'string' && row.tier !== TIER_SEED && row.tier >= incomingTier
  );

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => right.tier - left.tier || left.lastSeenMs - right.lastSeenMs);

  return candidates[0];
};

// store a listing with tiered admission: below the cap the record simply lands;
// at the cap the lowest-tier, least-recently-seen row makes room when one exists
const admitListing = (cache, record, options = {}) => {
  const { ttl, maxKeys, logger, context } = options;
  const hosts = context?.seedHosts instanceof Set ? context.seedHosts : seedHosts;

  if (!record || typeof record.id !== 'string' || record.id === '') {
    return false;
  }

  // the incoming record earns its tier from its own probe host and its own
  // recent uptime history, then keeps that tier while it stays in the cache
  const incomingTier = resolveTier(record, context);

  if (cache.has(record.id) || cache.keys().length < maxKeys) {
    record.admissionTier = incomingTier;

    return storeListing(cache, record.id, record, ttl, maxKeys, logger);
  }

  const rows = [];

  for (const key of cache.keys()) {
    const row = cache.get(key);

    if (!row || typeof row !== 'object') {
      continue;
    }

    // each row is judged by the tier it earned at its own admission. A seed
    // host always re-derives Tier A from its address, so the top tier never
    // depends on the database. Rows without a stored tier (never admitted
    // through this path) count as the lowest tier.
    const tier = hosts.has(probeHostName(row))
      ? TIER_SEED
      : Number.isInteger(row.admissionTier)
        ? row.admissionTier
        : TIER_NEW;

    rows.push({
      id: key,
      tier,
      lastSeenMs: Date.parse(row.status?.lastSeen) || 0,
    });
  }

  const victim = pickEviction(rows, incomingTier);

  if (!victim) {
    logger?.warn('Rejected a listing because the full node cache holds no evictable tier', {
      nodeId: record.id,
    });
    return false;
  }

  cache.del(victim.id);
  record.admissionTier = incomingTier;

  return storeListing(cache, record.id, record, ttl, maxKeys, logger);
};

module.exports = {
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
  uptimeThresholdDays,
  uptimeTicksRequired,
};
