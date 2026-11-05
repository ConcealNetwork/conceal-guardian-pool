const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('commitListing chain gate wiring', () => {
  it('runs the chain gate before admission and leaves host:port eviction to admitListing', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const start = source.indexOf('const commitListing');
    const end = source.indexOf('if (mustProbe', start);
    const commit = source.slice(start, end);
    const gateAt = commit.indexOf('applyChainGate(');
    const rejectAt = commit.indexOf('if (!gate.ok)');
    const admitAt = commit.indexOf('admitListing(');

    assert.ok(gateAt !== -1);
    assert.ok(rejectAt !== -1);
    assert.ok(admitAt !== -1);
    assert.ok(gateAt < rejectAt);
    assert.ok(rejectAt < admitAt);
    assert.match(commit.slice(rejectAt, admitAt), /callback\(false\)/);
    assert.match(commit.slice(rejectAt, admitAt), /return;/);
    assert.match(commit.slice(admitAt), /occupantId:\s*result\.evictId/);
    assert.equal(commit.includes('nodeCache.del(result.evictId)'), false);
  });
});

describe('held anchor slack wiring', () => {
  it('gives the list filter and the commit gate the same listing-anchor resolver', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const filterAt = source.indexOf('const listingAnchor = resolveListingAnchor(');
    const gateAt = source.indexOf('const listingAnchor = resolveListingAnchor(', filterAt + 1);
    const syncedAt = source.indexOf('return syncedNodes(');
    const applyAt = source.indexOf('applyChainGate(');
    const args =
      /resolveListingAnchor\(\s*seedAnchor,\s*lastSeedAnchor,\s*monotonicNowMs\(\)\s*\)/g;
    const matches = source.match(args) || [];

    assert.ok(filterAt !== -1);
    assert.ok(gateAt !== -1);
    assert.ok(syncedAt !== -1);
    assert.ok(applyAt !== -1);
    assert.equal(matches.length, 2);
    assert.ok(filterAt < syncedAt && syncedAt < gateAt && gateAt < applyAt);
    assert.ok(source.slice(syncedAt, syncedAt + 200).includes('listingAnchor.height'));
    assert.ok(source.slice(syncedAt, syncedAt + 200).includes('listingAnchor.slack'));
    assert.ok(source.slice(applyAt, applyAt + 250).includes('listingAnchor.height'));
    assert.ok(source.slice(applyAt, applyAt + 250).includes('listingAnchor.slack'));
  });
});

describe('pool update submitter IP', () => {
  it('assigns req.ip onto the sanitized record before setNodeData', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const start = source.indexOf("app.post('/pool/update'");
    const end = source.indexOf("app.options('/pool/uptime'", start);
    const handler = source.slice(start, end);
    const recordAt = handler.indexOf('if (record)');
    const assignAt = handler.indexOf('record.submitterIp = req.ip');
    const setAt = handler.indexOf('setNodeData(record');

    assert.ok(start !== -1);
    assert.ok(recordAt !== -1);
    assert.ok(assignAt !== -1);
    assert.ok(setAt !== -1);
    assert.ok(recordAt < assignAt);
    assert.ok(assignAt < setAt);
  });
});
