// Copyright (c) 2019 -2026, Acktarius, The Conceal Developers
//
// Please see the included LICENSE file for more information.

const dns = require('node:dns');
const http = require('node:http');
const { isAddressBlocked, isHostAllowed, isValidPort } = require('./validate');

const isSeed = (seed) => Boolean(seed) && isHostAllowed(seed.host) && isValidPort(seed.port);

// Last address learned for each seed name. Used only when that name fails to resolve.
const cachedAddress = (pins, host) => {
  if (!pins || typeof pins.get !== 'function') {
    return null;
  }

  const address = pins.get(host);

  return typeof address === 'string' && address.length > 0 ? address : null;
};

const rememberAddress = (pins, host, address) => {
  if (pins && typeof pins.set === 'function') {
    pins.set(host, address);
  }
};

// Fresh public addresses only. A blocked answer is a failed resolution, so the
// caller can fall back to the last address instead of dialing it.
const resolveSeedAddress = (host, lookup = dns.lookup) =>
  new Promise((resolve) => {
    lookup(host, { all: true, verbatim: true }, (error, addresses) => {
      if (error || !Array.isArray(addresses) || addresses.length === 0) {
        resolve({ address: null, reason: 'lookup' });
        return;
      }

      if (addresses.some((entry) => isAddressBlocked(entry.address))) {
        resolve({ address: null, reason: 'blocked' });
        return;
      }

      resolve({ address: addresses[0].address, reason: null });
    });
  });

const fetchSeedInfo = (host, address, port, timeoutMs) =>
  new Promise((resolve) => {
    const request = http.request(
      {
        host: address,
        port,
        path: '/getinfo',
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          accept: 'application/json',
          host: `${host}:${port}`,
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          resolve(null);
          return;
        }

        let body = '';
        let settled = false;
        const finish = (info) => {
          if (settled) {
            return;
          }

          settled = true;
          resolve(info);
        };

        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;

          if (body.length > 65536) {
            request.destroy();
            finish(null);
          }
        });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const info = parsed && typeof parsed === 'object' ? (parsed.result ?? parsed) : null;

            finish(info && typeof info === 'object' ? info : null);
          } catch {
            finish(null);
          }
        });
      }
    );

    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
    request.on('error', () => resolve(null));
    request.end();
  });

// A string is a fresh address. null is a failed lookup. The default resolver
// returns { address, reason } so a blocked answer stays distinct from a lookup error.
const asResolution = (resolved) => {
  if (resolved && typeof resolved === 'object' && Object.hasOwn(resolved, 'address')) {
    return {
      address:
        typeof resolved.address === 'string' && resolved.address.length > 0
          ? resolved.address
          : null,
      reason:
        resolved.reason === 'blocked' || resolved.reason === 'lookup' ? resolved.reason : null,
    };
  }

  if (typeof resolved === 'string' && resolved.length > 0) {
    return { address: resolved, reason: null };
  }

  return { address: null, reason: 'lookup' };
};

// Prefer the current DNS answer and remember it. The remembered address is used
// only when this round cannot resolve the name.
const resolveSeedTarget = (seed, pins, resolveAddress) => {
  if (!isSeed(seed)) {
    return Promise.resolve(null);
  }

  return Promise.resolve(resolveAddress(seed.host)).then((resolved) => {
    const outcome = asResolution(resolved);
    const address = outcome.address || cachedAddress(pins, seed.host);

    if (!address) {
      return { host: seed.host, address: null, reason: outcome.reason };
    }

    if (outcome.address) {
      rememberAddress(pins, seed.host, outcome.address);
    }

    return {
      host: seed.host,
      address,
      port: Number(seed.port),
      remembered: !outcome.address,
      reason: outcome.address ? null : outcome.reason,
    };
  });
};

const tipHashPattern = /^[0-9a-f]{64}$/i;

const fetchBlockHeader = (host, address, port, height, timeoutMs) =>
  new Promise((resolve) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      method: 'getblockheaderbyheight',
      params: { height },
    });
    const request = http.request(
      {
        host: address,
        port,
        path: '/json_rpc',
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          host: `${host}:${port}`,
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          resolve(null);
          return;
        }

        let raw = '';
        let settled = false;
        const finish = (header) => {
          if (settled) {
            return;
          }

          settled = true;
          resolve(header);
        };

        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          raw += chunk;

          if (raw.length > 65536) {
            request.destroy();
            finish(null);
          }
        });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            const result = parsed && typeof parsed === 'object' ? parsed.result : null;

            finish(result && typeof result === 'object' ? result : null);
          } catch {
            finish(null);
          }
        });
      }
    );

    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
    request.on('error', () => resolve(null));
    request.end(body);
  });

// header at H-1 carries that block's hash and prev_hash (H-2)
const readPriorTips = (result, height) => {
  const header = result?.block_header;

  if (result?.status !== 'OK' || !header || header.height !== height || height < 1) {
    return [];
  }

  const hash = typeof header.hash === 'string' ? header.hash.toLowerCase() : '';
  const prev = typeof header.prev_hash === 'string' ? header.prev_hash.toLowerCase() : '';

  if (!tipHashPattern.test(hash) || !tipHashPattern.test(prev)) {
    return [];
  }

  return [
    { height: height - 1, hash: prev },
    { height, hash },
  ];
};

const dialsForAnchor = (dials, replies, anchor) => {
  const matches = [];

  if (!anchor || !Array.isArray(dials) || !Array.isArray(replies)) {
    return matches;
  }

  for (let index = 0; index < replies.length; index++) {
    const reply = replies[index];
    const dial = dials[index];

    if (!dial || !reply || reply.height !== anchor.height) {
      continue;
    }

    const hash = typeof reply.top_block_hash === 'string' ? reply.top_block_hash.toLowerCase() : '';

    if (hash === anchor.hash) {
      matches.push(dial);
    }
  }

  return matches;
};

const tipKey = (tips) => tips.map((tip) => `${tip.height}:${tip.hash}`).join('|');

// one seed at a time; stop when `quorum` answers share one pair, otherwise seed nothing
const priorTipsFromSeeds = async (dials, height, timeoutMs, options = {}) => {
  const fetchHeader = options.fetchHeader ?? fetchBlockHeader;
  const quorum = Number.isInteger(options.quorum) && options.quorum >= 1 ? options.quorum : 3;

  if (!Array.isArray(dials)) {
    return [];
  }

  const seen = new Map();

  for (const dial of dials) {
    const tips = readPriorTips(
      await fetchHeader(dial.host, dial.address, dial.port, height, timeoutMs),
      height
    );

    if (tips.length === 0) {
      continue;
    }

    const key = tipKey(tips);
    const count = (seen.get(key) ?? 0) + 1;

    if (count >= quorum) {
      return tips;
    }

    seen.set(key, count);
  }

  return [];
};

const sampleSeed = (seed, timeoutMs, pins, resolveAddress = resolveSeedAddress) =>
  resolveSeedTarget(seed, pins, resolveAddress).then((target) =>
    target?.address ? fetchSeedInfo(target.host, target.address, target.port, timeoutMs) : null
  );

// One reply per address and port. The first seed in the list keeps that slot.
const sampleSeeds = (seeds, timeoutMs, pins, resolveAddress = resolveSeedAddress) => {
  const list = Array.isArray(seeds) ? seeds : [];

  return Promise.all(list.map((seed) => resolveSeedTarget(seed, pins, resolveAddress))).then(
    (targets) => {
      const seen = new Set();
      const rememberedHosts = [];
      const lookupFailures = [];
      const blockedHosts = [];
      const droppedHosts = [];

      const dials = [];
      const replies = Promise.all(
        targets.map((target) => {
          if (!target?.address) {
            dials.push(null);

            if (target?.reason === 'blocked') {
              blockedHosts.push(target.host);
            } else if (target?.reason === 'lookup') {
              lookupFailures.push(target.host);
            }

            return null;
          }

          if (target.reason === 'blocked') {
            blockedHosts.push(target.host);
          } else if (target.reason === 'lookup') {
            lookupFailures.push(target.host);
          }

          if (target.remembered) {
            rememberedHosts.push(target.host);
          }

          const key = `${target.address}|${target.port}`;

          if (seen.has(key)) {
            dials.push(null);
            droppedHosts.push(target.host);
            return null;
          }

          seen.add(key);
          dials.push({ host: target.host, address: target.address, port: target.port });
          return fetchSeedInfo(target.host, target.address, target.port, timeoutMs);
        })
      );

      return replies.then((resolvedReplies) => ({
        replies: resolvedReplies,
        dials,
        rememberedHosts,
        lookupFailures,
        blockedHosts,
        droppedHosts,
      }));
    }
  );
};

module.exports = {
  dialsForAnchor,
  fetchBlockHeader,
  priorTipsFromSeeds,
  isSeed,
  readPriorTips,
  resolveSeedAddress,
  sampleSeed,
  sampleSeeds,
};
