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
const tierNewPerIp = resolvePositiveInt(config.admission?.tierNewPerIp, 2);
const uptimePeriodSeconds = resolvePositiveInt(config.uptime?.period, 60);

// 60 s ticks -> 1440 per day -> 4320 ticks for the 3-day default threshold
const uptimeTicksRequired = (uptimeThresholdDays * 24 * 60 * 60) / uptimePeriodSeconds;

// how many recent calendar months of uptime history count toward the threshold;
// the recency bound is intentional: old ticks must not earn a tier forever.
// Sizing: window = ceil(thresholdDays / 30) + 1 months so the threshold span is
// always fully contained across month boundaries; ticks older than the window
// never count toward Tier B.
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

// each row is judged by the tier it earned at its own admission. A seed host
// always re-derives Tier A from its address, so the top tier never depends on
// the database. Rows without a stored tier count as the lowest tier.
const storedTier = (row, hosts) => {
  if (hosts.has(probeHostName(row))) {
    return TIER_SEED;
  }

  return Number.isInteger(row.admissionTier) ? row.admissionTier : TIER_NEW;
};

// a different id may take a host:port only from an equal or lower tier.
// a seed-hosted row never yields, including to another seed-hosted id.
const occupantYields = (cache, occupantId, incomingId, incomingTier, hosts) => {
  if (typeof occupantId !== 'string' || occupantId === '' || occupantId === incomingId) {
    return true;
  }

  const occupant = cache.get(occupantId);

  if (!occupant || typeof occupant !== 'object') {
    return true;
  }

  const occupantTier = storedTier(occupant, hosts);

  return occupantTier !== TIER_SEED && occupantTier >= incomingTier;
};

const tierNewSeatsForIp = (cache, submitterIp, hosts) => {
  const seats = [];

  for (const key of cache.keys()) {
    const row = cache.get(key);

    if (!row || typeof row !== 'object' || row.submitterIp !== submitterIp) {
      continue;
    }

    if (storedTier(row, hosts) !== TIER_NEW) {
      continue;
    }

    seats.push({
      id: key,
      lastSeenMs: Date.parse(row.status?.lastSeen) || 0,
    });
  }

  return seats;
};

// tier C is capped per submitter. Seed and uptime skip the cap. A refresh
// keeps its seat. At the cap, that IP's oldest tier-C row makes room.
const holdTierNewCap = (cache, record, incomingTier, perIpCap, hosts) => {
  if (incomingTier !== TIER_NEW || cache.has(record.id)) {
    return true;
  }

  const submitterIp = record.submitterIp;

  if (typeof submitterIp !== 'string' || submitterIp === '') {
    return false;
  }

  const seats = tierNewSeatsForIp(cache, submitterIp, hosts);

  if (seats.length >= perIpCap) {
    seats.sort((left, right) => left.lastSeenMs - right.lastSeenMs);
    cache.del(seats[0].id);
  }

  return true;
};

const listedRows = (cache, hosts) => {
  const rows = [];

  for (const key of cache.keys()) {
    const row = cache.get(key);

    if (!row || typeof row !== 'object') {
      continue;
    }

    rows.push({
      id: key,
      tier: storedTier(row, hosts),
      lastSeenMs: Date.parse(row.status?.lastSeen) || 0,
    });
  }

  return rows;
};

const makeRoom = (cache, record, incomingTier, hosts, maxKeys, logger) => {
  if (cache.has(record.id) || cache.keys().length < maxKeys) {
    return true;
  }

  const victim = pickEviction(listedRows(cache, hosts), incomingTier);

  if (!victim) {
    logger?.warn('Rejected a listing because the full node cache holds no evictable tier', {
      nodeId: record.id,
    });
    return false;
  }

  cache.del(victim.id);

  return true;
};

// store a listing with tiered admission: below the cap the record simply lands;
// at the cap the lowest-tier, least-recently-seen row makes room when one exists.
// a host:port already held by a protected tier is refused before any seat is freed.
const admitListing = (cache, record, options = {}) => {
  const { ttl, maxKeys, logger, context, occupantId } = options;
  const hosts = context?.seedHosts instanceof Set ? context.seedHosts : seedHosts;
  const perIpCap = resolvePositiveInt(context?.tierNewPerIp, tierNewPerIp);

  if (!record || typeof record.id !== 'string' || record.id === '') {
    return false;
  }

  // the incoming record earns its tier from its own probe host and its own
  // recent uptime history, then keeps that tier while it stays in the cache
  const incomingTier = resolveTier(record, context);

  if (!occupantYields(cache, occupantId, record.id, incomingTier, hosts)) {
    logger?.warn('Rejected a listing because its host:port is held by a protected tier', {
      nodeId: record.id,
      occupantId,
    });
    return false;
  }

  if (!holdTierNewCap(cache, record, incomingTier, perIpCap, hosts)) {
    return false;
  }

  if (typeof occupantId === 'string' && occupantId !== '' && occupantId !== record.id) {
    cache.del(occupantId);
  }

  if (!makeRoom(cache, record, incomingTier, hosts, maxKeys, logger)) {
    return false;
  }

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
  tierNewPerIp,
  trailingRingDepth,
  uptimeMonthsWindow,
  uptimeThresholdDays,
  uptimeTicksRequired,
};
