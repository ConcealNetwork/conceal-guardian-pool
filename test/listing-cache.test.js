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

  it('refuses a new listing when the cache is full', () => {
    const warnings = [];
    const cache = fullCache();
    const stored = storeListing(cache, 'c', { n: 3 }, ttl, maxKeys, {
      warn(message, fields) {
        warnings.push({ message, fields });
      },
    });

    assert.equal(stored, false);
    assert.equal(cache.get('c'), undefined);
    assert.deepEqual(cache.get('b'), { n: 2 });
    assert.deepEqual(warnings, [
      {
        message: 'Rejected a listing because the node cache is full',
        fields: { nodeId: 'c' },
      },
    ]);
  });
});
