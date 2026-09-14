// Copyright (c) 2019 -2026, Taegus Cromis, The Conceal Developers
//
// Please see the included LICENSE file for more information.

// node id pattern and host character set used for update validation
const nodeIdPattern = /^[a-zA-Z0-9\-_]+$/;
const hostCharsetPattern = /^[a-zA-Z0-9.\-:[\]]+$/;

// hosts that are never accepted as node or probe targets
const blockedHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::', '::1']);

// max height accepted in an update payload
const maxHeight = 100000000;

const isValidNodeId = (id) =>
  typeof id === 'string' && id.length > 0 && id.length <= 100 && nodeIdPattern.test(id);

const isHostAllowed = (host) => {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) {
    return false;
  }

  if (!hostCharsetPattern.test(host)) {
    return false;
  }

  const normalized = host.replace(/^\[|]$/g, '').toLowerCase();

  if (blockedHosts.has(normalized)) {
    return false;
  }

  // loopback, link-local and unspecified address ranges
  return !/^127\.|^169\.254\.|^0\.|^fe80:/.test(normalized);
};

const isValidPort = (port) => {
  const value = Number(port);

  return Number.isInteger(value) && value >= 1 && value <= 65535;
};

module.exports = { isHostAllowed, isValidNodeId, isValidPort, maxHeight };
