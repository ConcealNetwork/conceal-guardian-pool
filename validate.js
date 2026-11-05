// Copyright (c) 2019 -2026, Taegus Cromis, The Conceal Developers
//
// Please see the included LICENSE file for more information.

// Guardian nodedata.json id: UUID v4 from pure-uuid format()
const nodeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hostCharsetPattern = /^[a-zA-Z0-9.\-:[\]]+$/;

// Set true to accept 127.0.0.1 / localhost for local pool testing (port is still 1-65535).
const allowLocalhost = false;

// Tip observed 2026-11-05 03:31 UTC: height 2193403.
const heightAnchor = 2193403;
const heightAnchorMs = Date.parse('2026-11-05T03:31:00.000Z');
const blockTimeSeconds = 120;
const heightAheadBlocks = (10 * 24 * 60 * 60) / blockTimeSeconds;

const expectedHeight = (nowMs = Date.now()) =>
  heightAnchor + Math.floor((nowMs - heightAnchorMs) / (blockTimeSeconds * 1000));

// Write path: reject a height more than 10 days ahead of the expected tip.
const isSubmittedHeightAccepted = (height, nowMs = Date.now()) =>
  Number.isFinite(height) && height >= 0 && height <= expectedHeight(nowMs) + heightAheadBlocks;

// Strict canonical dotted-quad only. Non-canonical IPv4 forms (decimal '2130706433',
// hex '0x7f000001', octal-ish '0177.0.0.1', short '127.1') return null so callers
// can fail closed instead of treating them as resolvable hostnames.
const parseIpv4 = (host) => {
  const parts = host.split('.');

  if (parts.length !== 4) {
    return null;
  }

  const octets = parts.map((part) => {
    // leading zeros are rejected: '0177' is ambiguous octal input, not a canonical octet
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) {
      return Number.NaN;
    }

    return Number(part);
  });

  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return octets;
};

// One side of an IPv6 literal. A dotted quad is legal only as the final piece,
// so it is allowed on the right of '::' and on an uncompressed address.
const parseIpv6Side = (side, allowQuad) => {
  if (side === '') {
    return { groups: [], embedded: null };
  }

  let groupsPart = side;
  let embedded = null;

  if (side.includes('.')) {
    if (!allowQuad) {
      return null;
    }

    const lastColon = side.lastIndexOf(':');
    const quad = lastColon === -1 ? side : side.slice(lastColon + 1);
    const octets = parseIpv4(quad);

    if (!octets) {
      return null;
    }

    embedded = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    groupsPart = lastColon === -1 ? '' : side.slice(0, lastColon);
  }

  const groups = groupsPart === '' ? [] : groupsPart.split(':');

  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }

  return { groups, embedded };
};

// Parse a bracket-free, lowercase IPv6 literal into its 8 16-bit groups.
// Supports '::' compression once and an embedded dotted-quad tail, including
// a quad that sits directly against the compression ('64:ff9b::1.2.3.4').
const parseIpv6 = (host) => {
  if (host.includes(':::')) {
    return null;
  }

  const halves = host.split('::');

  if (halves.length > 2) {
    return null;
  }

  const head = parseIpv6Side(halves[0], halves.length === 1);

  if (!head) {
    return null;
  }

  let tailGroups = [];
  let embedded = head.embedded;

  if (halves.length === 2) {
    const tail = parseIpv6Side(halves[1], true);

    if (!tail) {
      return null;
    }

    tailGroups = tail.groups;
    embedded = tail.embedded;
  }

  const missing = 8 - head.groups.length - tailGroups.length - (embedded ? 2 : 0);

  if (missing < 0 || (halves.length === 1 && missing !== 0)) {
    return null;
  }

  const groups = [...head.groups, ...Array(missing).fill('0'), ...tailGroups].map((group) =>
    Number.parseInt(group, 16)
  );

  if (embedded) {
    groups.push(embedded[0], embedded[1]);
  }

  return groups;
};

const isBlockedIpv4 = (octets) => {
  const [a, b] = octets;

  // 0.0.0.0/8 unspecified, 10.0.0.0/8, 100.64.0.0/10 shared, 127.0.0.0/8,
  // 169.254.0.0/16 link-local, 172.16.0.0/12, 192.168.0.0/16,
  // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
};

const ipv4FromGroups = (high, low) => [high >> 8, high & 0xff, low >> 8, low & 0xff];

const isLoopbackIpv6 = (groups) =>
  groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;

const isBlockedIpv6 = (groups) => {
  if (isLoopbackIpv6(groups)) {
    return true;
  }

  if (groups[0] === 0) {
    // '::' unspecified
    if (groups.every((group) => group === 0)) {
      return true;
    }

    // ::/96 with an embedded IPv4 tail: the mapped form ::ffff:0:0/96 and the
    // deprecated IPv4-compatible form are both judged by the embedded IPv4 ranges
    if (
      groups.slice(1, 5).every((group) => group === 0) &&
      (groups[5] === 0xffff || groups[6] !== 0 || groups[7] !== 0)
    ) {
      return isBlockedIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
    }

    // IPv4-translated (SIIT) form ::ffff:0:a.b.c.d: 0xffff at group 4 — judged by
    // the embedded IPv4 ranges, symmetric with the mapped form above
    if (
      groups[1] === 0 &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0xffff &&
      groups[5] === 0
    ) {
      return isBlockedIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
    }
  }

  // 6to4 2002::/16 embeds IPv4 in groups 1 and 2
  if (groups[0] === 0x2002) {
    return isBlockedIpv4(ipv4FromGroups(groups[1], groups[2]));
  }

  // NAT64 well-known prefix 64:ff9b::/96 embeds IPv4 in the last 32 bits
  if (
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0)
  ) {
    return isBlockedIpv4(ipv4FromGroups(groups[6], groups[7]));
  }

  // fe80::/10 link-local, fec0::/10 site-local, fc00::/7 unique-local, ff00::/8 multicast
  return (
    groups[0] >>> 6 === 0x3fa ||
    groups[0] >>> 6 === 0x3fb ||
    groups[0] >>> 9 === 0x7e ||
    groups[0] >>> 8 === 0xff
  );
};

// classify an already-resolved address (probe-time pinning): true means the
// address must never be connected to. Unparseable input fails closed.
const isAddressBlocked = (address) => {
  if (typeof address !== 'string' || address.length === 0) {
    return true;
  }

  const candidate = address.replace(/^\[|]$/g, '').toLowerCase();

  if (candidate.includes(':')) {
    const groups = parseIpv6(candidate);

    return groups ? isBlockedIpv6(groups) : true;
  }

  const octets = parseIpv4(candidate);

  return octets ? isBlockedIpv4(octets) : true;
};

const isOmittedPort = (port) => port === '' || port === undefined || port === null;

const isValidNodeId = (id) => typeof id === 'string' && nodeIdPattern.test(id);

const isHostAllowed = (host, options = {}) => {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) {
    return false;
  }

  if (/^https?:\/\//i.test(host)) {
    return false;
  }

  const slash = host.indexOf('/');
  const hostname = slash === -1 ? host : host.slice(0, slash);
  const path = slash === -1 ? '' : host.slice(slash);

  if (path && !/^\/[a-zA-Z0-9._-]+$/.test(path)) {
    return false;
  }

  if (!hostCharsetPattern.test(hostname)) {
    return false;
  }

  const normalized = hostname.replace(/^\[|]$/g, '').toLowerCase();
  const localhostOk = options.allowLocalhost === true || allowLocalhost;

  // canonical names only: trailing dots and *.localhost never reach resolution
  if (normalized.endsWith('.') || normalized.endsWith('.localhost')) {
    return false;
  }

  if (normalized === 'localhost') {
    return localhostOk;
  }

  if (normalized.includes(':')) {
    const groups = parseIpv6(normalized);

    if (!groups) {
      return false;
    }

    if (isLoopbackIpv6(groups)) {
      return localhostOk;
    }

    return !isBlockedIpv6(groups);
  }

  // a numeric host must be a canonical dotted-quad; decimal, hex, octal and
  // shortened IPv4 literals ('2130706433', '0x7f000001', '10.0x1', '127.1') fail closed
  const hasHexLabel = normalized.split('.').some((label) => /^0x[0-9a-f]+$/i.test(label));

  if (/^[0-9.]+$/.test(normalized) || hasHexLabel) {
    const octets = parseIpv4(normalized);

    if (!octets) {
      return false;
    }

    if (octets[0] === 127) {
      return localhostOk;
    }

    return !isBlockedIpv4(octets);
  }

  // remaining single-label hostnames ('myhost', hex forms like '7f000001')
  // have no public resolution path and fail closed
  if (!normalized.includes('.')) {
    return false;
  }

  return true;
};

const isValidPort = (port) => {
  const value = Number(port);

  return Number.isInteger(value) && value >= 1 && value <= 65535;
};

// Conceal standard address: 98 chars, prefix ccx (live fees are ccx7…). Empty = no fee.
const isValidFeeAddress = (address) =>
  typeof address === 'string' &&
  (address === '' || (address.length === 98 && address.startsWith('ccx')));

module.exports = {
  allowLocalhost,
  blockTimeSeconds,
  expectedHeight,
  heightAnchor,
  heightAnchorMs,
  heightAheadBlocks,
  isAddressBlocked,
  isHostAllowed,
  isOmittedPort,
  isSubmittedHeightAccepted,
  isValidFeeAddress,
  isValidNodeId,
  isValidPort,
};
