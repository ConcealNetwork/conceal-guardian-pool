const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const { publicNodeId, toPublicNode, toPublicUptime, resolvePrivateId } = require('../public-id');

const rawId = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const expectedPublicId = createHash('sha256').update(rawId, 'utf8').digest('hex');

describe('publicNodeId', () => {
  it('returns the sha256 hex of the guardian uuid', () => {
    assert.equal(publicNodeId(rawId), expectedPublicId);
    assert.equal(expectedPublicId.length, 64);
    assert.notEqual(publicNodeId(rawId), rawId);
  });
});

describe('toPublicNode', () => {
  it('replaces id with the public hash and does not mutate the cached record', () => {
    const node = { id: rawId, nodeHost: '203.0.113.10', nodePort: 16000 };
    const published = toPublicNode(node);

    assert.equal(published.id, expectedPublicId);
    assert.equal(published.nodeHost, '203.0.113.10');
    assert.equal(node.id, rawId);
  });
});

describe('toPublicUptime', () => {
  it('replaces each uptime id with the public hash', () => {
    const result = toPublicUptime({
      uptimes: [{ id: rawId, clientTicks: 10, serverTicks: 12 }],
    });

    assert.equal(result.uptimes[0].id, expectedPublicId);
    assert.equal(result.uptimes[0].clientTicks, 10);
  });
});

describe('resolvePrivateId', () => {
  it('maps a public hash back to the raw id when that id is known', () => {
    assert.equal(resolvePrivateId(expectedPublicId, [rawId]), rawId);
  });

  it('keeps a raw id that is already in the known set', () => {
    assert.equal(resolvePrivateId(rawId, [rawId]), rawId);
  });

  it('returns null when the value matches no known id', () => {
    assert.equal(resolvePrivateId(expectedPublicId, ['other-node']), null);
  });
});
