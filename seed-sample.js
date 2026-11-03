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
        resolve(null);
        return;
      }

      if (addresses.some((entry) => isAddressBlocked(entry.address))) {
        resolve(null);
        return;
      }

      resolve(addresses[0].address);
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

// Prefer the current DNS answer and remember it. The remembered address is used
// only when this round cannot resolve the name.
const resolveSeedTarget = (seed, pins, resolveAddress) => {
  if (!isSeed(seed)) {
    return Promise.resolve(null);
  }

  return Promise.resolve(resolveAddress(seed.host)).then((resolved) => {
    const address = resolved || cachedAddress(pins, seed.host);

    if (!address) {
      return null;
    }

    if (resolved) {
      rememberAddress(pins, seed.host, resolved);
    }

    return { host: seed.host, address, port: Number(seed.port) };
  });
};

const sampleSeed = (seed, timeoutMs, pins, resolveAddress = resolveSeedAddress) =>
  resolveSeedTarget(seed, pins, resolveAddress).then((target) =>
    target ? fetchSeedInfo(target.host, target.address, target.port, timeoutMs) : null
  );

// One reply per address and port. The first seed in the list keeps that slot.
const sampleSeeds = (seeds, timeoutMs, pins, resolveAddress = resolveSeedAddress) => {
  const list = Array.isArray(seeds) ? seeds : [];

  return Promise.all(list.map((seed) => resolveSeedTarget(seed, pins, resolveAddress))).then(
    (targets) => {
      const seen = new Set();

      return Promise.all(
        targets.map((target) => {
          if (!target) {
            return null;
          }

          const key = `${target.address}|${target.port}`;

          if (seen.has(key)) {
            return null;
          }

          seen.add(key);
          return fetchSeedInfo(target.host, target.address, target.port, timeoutMs);
        })
      );
    }
  );
};

module.exports = { isSeed, resolveSeedAddress, sampleSeed, sampleSeeds };
