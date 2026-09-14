// Copyright (c) 2019 -2026, Taegus Cromis, The Conceal Developers
//
// Please see the included LICENSE file for more information.

// Guardian nodedata.json id: UUID v4 from pure-uuid format()
const nodeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hostCharsetPattern = /^[a-zA-Z0-9.\-:[\]]+$/;

// hosts that are never accepted as node or probe targets
const blockedHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::', '::1']);

// Set true to accept 127.0.0.1 / localhost for local pool testing (port is still 1-65535).
const allowLocalhost = false;

// Tip observed 2026-09-14: height 2159003, 33761534 CCX minted (incl. deposits).
const heightAnchor = 2159003;
const heightAnchorMs = Date.parse('2026-09-14T22:50:00.000Z');
const blockTimeSeconds = 120;
const heightWeekBlocks = (7 * 24 * 60 * 60) / blockTimeSeconds;

const expectedHeight = (nowMs = Date.now()) =>
  heightAnchor + Math.floor((nowMs - heightAnchorMs) / (blockTimeSeconds * 1000));

// Write path: reject a fake future tip. A syncing node may report any lower height.
const isSubmittedHeightAccepted = (height, nowMs = Date.now()) =>
  Number.isFinite(height) && height >= 0 && height <= expectedHeight(nowMs) + heightWeekBlocks;

const parseIpv4 = (host) => {
  const parts = host.split('.');

  if (parts.length !== 4) {
    return null;
  }

  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return Number.NaN;
    }

    return Number(part);
  });

  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return octets;
};

const isLoopbackHost = (host) => host === 'localhost' || host === '::1' || host.startsWith('127.');

const isNonRoutableIpv4 = (octets) => {
  const [a, b] = octets;

  // 0.0.0.0/8 unspecified, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16,
  // 172.16.0.0/12, 192.168.0.0/16
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
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

  if (isLoopbackHost(normalized)) {
    return localhostOk;
  }

  if (blockedHosts.has(normalized) || /^fe80:/.test(normalized)) {
    return false;
  }

  const ipv4 = parseIpv4(normalized);

  if (ipv4 && isNonRoutableIpv4(ipv4)) {
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
  heightWeekBlocks,
  isHostAllowed,
  isOmittedPort,
  isSubmittedHeightAccepted,
  isValidFeeAddress,
  isValidNodeId,
  isValidPort,
};
