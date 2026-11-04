const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAnchorRing } = require('../anchor-ring');

describe('createAnchorRing', () => {
  it('accumulates published anchor tips in publication order', () => {
    const ring = createAnchorRing(5);

    ring.push({ height: 100, hash: 'a'.repeat(64) });
    ring.push({ height: 101, hash: 'B'.repeat(64) });

    assert.equal(ring.size(), 2);
    assert.deepEqual(ring.entries(), [
      { height: 100, hash: 'a'.repeat(64) },
      { height: 101, hash: 'b'.repeat(64) },
    ]);
    assert.equal(ring.maxHeight(), 101);
  });

  it('keeps one entry per height and refreshes the hash of a re-publication', () => {
    const ring = createAnchorRing(5);

    ring.push({ height: 100, hash: 'a'.repeat(64) });
    ring.push({ height: 100, hash: 'b'.repeat(64) });

    assert.equal(ring.size(), 1);
    assert.deepEqual(ring.entries()[0], { height: 100, hash: 'b'.repeat(64) });
  });

  it('evicts the oldest entry once the trailing depth is reached', () => {
    const ring = createAnchorRing(20);

    for (let offset = 0; offset < 25; offset++) {
      ring.push({ height: 1000 + offset, hash: String(offset).padStart(64, '0') });
    }

    assert.equal(ring.size(), 20);
    assert.equal(ring.entries()[0].height, 1005);
    assert.equal(ring.entries()[19].height, 1024);
    assert.equal(ring.maxHeight(), 1024);
  });

  it('ignores malformed anchors', () => {
    const ring = createAnchorRing(3);

    ring.push(null);
    ring.push({ height: 'x', hash: 'a'.repeat(64) });
    ring.push({ height: 100 });
    ring.push({ height: 100, hash: '' });
    ring.push({ height: -1, hash: 'a'.repeat(64) });

    assert.equal(ring.size(), 0);
  });

  it('treats a non-integer depth as the default of 20', () => {
    const ring = createAnchorRing('x');

    for (let height = 0; height < 21; height++) {
      ring.push({ height, hash: 'a'.repeat(64) });
    }

    assert.equal(ring.size(), 20);
    assert.equal(ring.entries()[0].height, 1);
  });

  it('hands out copies so callers cannot mutate the ring', () => {
    const ring = createAnchorRing(5);

    ring.push({ height: 100, hash: 'a'.repeat(64) });
    ring.entries()[0].height = 1;

    assert.deepEqual(ring.entries()[0], { height: 100, hash: 'a'.repeat(64) });
  });
});
