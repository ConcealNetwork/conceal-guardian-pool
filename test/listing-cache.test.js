const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const NodeCache = require('node-cache');

const { storeListing } = require('../listing-cache');

const silent = { warn() {} };
const ttl = 60;
const maxKeys = 2;

const fullCache = () => {
  const cache = new NodeCache({ stdTTL: ttl, maxKeys });

  cache.set('a', { n: 1 });
  cache.set('b', { n: 2 });

  return cache;
};

const recordSeen = (id, iso) => ({ id, status: { lastSeen: iso } });

describe('storeListing', () => {
  it('stores a new listing below the cap', () => {
    const cache = new NodeCache({ stdTTL: ttl, maxKeys });

    assert.equal(storeListing(cache, 'a', { n: 1 }, ttl, maxKeys, silent), true);
    assert.deepEqual(cache.get('a'), { n: 1 });
  });

  it('refreshes a stored listing when the cache is full', () => {
    const cache = fullCache();

    assert.equal(storeListing(cache, 'a', { n: 9 }, ttl, maxKeys, silent), true);
    assert.deepEqual(cache.get('a'), { n: 9 });
    assert.equal(cache.getStats().keys, maxKeys);
  });

  it('evicts the least recently seen listing to make room when full', () => {
    const cap = 5;
    const cache = new NodeCache({ stdTTL: ttl, maxKeys: cap });
    const base = Date.parse('2026-11-04T00:00:00.000Z');

    for (let index = 0; index < cap; index++) {
      cache.set(`n${index}`, recordSeen(`n${index}`, new Date(base + index * 1000).toISOString()));
    }

    const stored = storeListing(
      cache,
      'new',
      recordSeen('new', new Date(base + 9000).toISOString()),
      ttl,
      cap,
      silent
    );

    assert.equal(stored, true);
    assert.equal(cache.get('n0'), undefined);
    assert.notEqual(cache.get('new'), undefined);
    assert.equal(cache.getStats().keys, cap);
  });

  it('stays bounded and does not throw under a flood past the cap', () => {
    const cap = 5;
    const cache = new NodeCache({ stdTTL: ttl, maxKeys: cap });
    const base = Date.parse('2026-11-04T00:00:00.000Z');

    for (let index = 0; index < 20; index++) {
      const stored = storeListing(
        cache,
        `f${index}`,
        recordSeen(`f${index}`, new Date(base + index * 1000).toISOString()),
        ttl,
        cap,
        silent
      );

      assert.equal(stored, true);
      assert.ok(cache.getStats().keys <= cap);
    }

    assert.equal(cache.getStats().keys, cap);
  });

  it('evicts entries without lastSeen before dated ones', () => {
    const cap = 2;
    const cache = new NodeCache({ stdTTL: ttl, maxKeys: cap });

    cache.set('dated', recordSeen('dated', new Date().toISOString()));
    cache.set('stale', { n: 1 });

    const stored = storeListing(
      cache,
      'new',
      recordSeen('new', new Date().toISOString()),
      ttl,
      cap,
      silent
    );

    assert.equal(stored, true);
    assert.equal(cache.get('stale'), undefined);
    assert.notEqual(cache.get('new'), undefined);
    assert.notEqual(cache.get('dated'), undefined);
    assert.equal(cache.getStats().keys, cap);
  });

  it('rethrows errors that are not cache-full', () => {
    const cache = {
      getStats: () => ({ keys: 0 }),
      has: () => false,
      set: () => {
        throw new Error('boom');
      },
      keys: () => [],
      del: () => {},
    };

    assert.throws(() => storeListing(cache, 'a', { n: 1 }, ttl, maxKeys, silent), /boom/);
  });
});
