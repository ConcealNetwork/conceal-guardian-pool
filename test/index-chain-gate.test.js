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
  it('gives the list filter and the commit gate the same slack call', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const call = 'anchorSlackBlocks(seedAnchor, monotonicNowMs())';
    const filterAt = source.indexOf('return syncedNodes(');
    const gateAt = source.indexOf('applyChainGate(');

    assert.ok(filterAt !== -1);
    assert.ok(gateAt !== -1);
    assert.ok(source.slice(filterAt, filterAt + 400).includes(call));
    assert.ok(source.slice(gateAt, gateAt + 400).includes(call));
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
