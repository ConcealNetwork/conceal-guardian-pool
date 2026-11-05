const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAnchorRing } = require('../anchor-ring');
const {
  applyChainGate,
  applyListingUpdate,
  chainVerdict,
  listingKey,
  mustProbe,
  occupantIdForKey,
  preserveProbedChain,
  probeSkipMs,
  syncedNodes,
} = require('../listing-policy');

const ipNode = (id, host = '203.0.113.10', port = 16000) => ({
  id,
  nodeHost: host,
  nodePort: port,
});

const domainNode = (id, host = 'ccxapi.conceal.network/daemon') => ({
  id,
  nodeHost: '203.0.113.10',
  nodePort: 16000,
  url: { host, port: '' },
});

describe('listingKey', () => {
  it('uses nodeHost and nodePort when there is no domain url', () => {
    const data = ipNode('u1');
    assert.equal(listingKey(data), `${data.nodeHost.toLowerCase()}:${data.nodePort}`);
  });

  it('uses port 443 when a domain url omits the port', () => {
    const data = domainNode('u1');
    assert.equal(listingKey(data), `${data.url.host.toLowerCase()}:443`);
  });
});

describe('mustProbe', () => {
  const now = 1_000_000;
  const data = ipNode('u1');

  it('probes when the id is new', () => {
    assert.equal(mustProbe(null, data, null, now), true);
  });

  it('probes when the listing key changed', () => {
    const existing = ipNode('u1', '198.51.100.7', 16000);
    assert.equal(mustProbe(existing, data, now - 1000, now), true);
  });

  it('skips when the same key was probed inside the skip window', () => {
    const existing = ipNode('u1');
    assert.equal(mustProbe(existing, data, now - 60 * 1000, now), false);
  });

  it('probes when the last probe is older than the skip window', () => {
    const existing = ipNode('u1');
    assert.equal(mustProbe(existing, data, now - probeSkipMs - 1, now), true);
  });
});

describe('applyListingUpdate', () => {
  it('rejects a new unreachable node and does not evict', () => {
    const data = ipNode('u-new');
    const result = applyListingUpdate({
      data,
      existing: null,
      reachable: false,
      occupantId: 'u-old',
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'new-unreachable');
    assert.equal(result.evictId, undefined);
  });

  it('keeps last probed chain fields when a same-key probe fails', () => {
    const existing = {
      ...ipNode('u1'),
      blockchain: { height: 2159003, fee_address: '', status: 'OK' },
    };
    const data = {
      ...ipNode('u1'),
      blockchain: { height: 12, fee_address: 'ccx7x', status: 'LIE' },
    };
    const result = applyListingUpdate({
      data,
      existing,
      reachable: false,
      occupantId: undefined,
    });

    assert.equal(result.ok, true);
    assert.equal(result.store.blockchain.height, existing.blockchain.height);
    assert.equal(result.store.blockchain.fee_address, existing.blockchain.fee_address);
    assert.equal(result.store.blockchain.status, existing.blockchain.status);
  });

  it('stores a new reachable node', () => {
    const data = ipNode('u-new');
    const result = applyListingUpdate({
      data,
      existing: null,
      reachable: true,
      occupantId: undefined,
    });

    assert.equal(result.ok, true);
    assert.equal(result.store.id, data.id);
    assert.equal(result.evictId, undefined);
  });

  it('rejects a move to an unreachable host and does not evict', () => {
    const existing = ipNode('u1', '198.51.100.7', 16000);
    const data = ipNode('u1');
    const result = applyListingUpdate({
      data,
      existing,
      reachable: false,
      occupantId: undefined,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'move-unreachable');
    assert.equal(result.evictId, undefined);
  });

  it('stores a move to a reachable host', () => {
    const existing = ipNode('u1', '198.51.100.7', 16000);
    const data = ipNode('u1');
    const result = applyListingUpdate({
      data,
      existing,
      reachable: true,
      occupantId: undefined,
    });

    assert.equal(result.ok, true);
    assert.equal(result.store.id, data.id);
    assert.equal(listingKey(result.store), listingKey(data));
  });

  it('evicts the occupant only when the new id is reachable', () => {
    const occupant = ipNode('u-old');
    const data = ipNode('u-new');
    const rows = [occupant];

    const fail = applyListingUpdate({
      data,
      existing: null,
      reachable: false,
      occupantId: occupantIdForKey(rows, listingKey(data), data.id),
    });
    assert.equal(fail.ok, false);
    assert.equal(fail.evictId, undefined);

    const ok = applyListingUpdate({
      data,
      existing: null,
      reachable: true,
      occupantId: occupantIdForKey(rows, listingKey(data), data.id),
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.evictId, occupant.id);
  });
});

describe('preserveProbedChain', () => {
  it('keeps last probed height, fee and daemon status', () => {
    const incoming = {
      id: 'u1',
      blockchain: { height: 100, fee_address: 'ccx7posted', status: 'LIE' },
    };
    const existing = {
      id: 'u1',
      blockchain: { height: 2159003, fee_address: '', status: 'OK' },
    };

    const stored = preserveProbedChain(incoming, existing);

    assert.equal(stored.blockchain.height, existing.blockchain.height);
    assert.equal(stored.blockchain.fee_address, existing.blockchain.fee_address);
    assert.equal(stored.blockchain.status, existing.blockchain.status);
  });

  it('keeps last probed daemon version and other getinfo fields on skip', () => {
    const incoming = {
      id: 'u1',
      version: '1.2.3',
      blockchain: { height: 100, fee_address: 'ccx7posted', status: 'LIE' },
    };
    const existing = {
      id: 'u1',
      version: '1.2.2',
      blockchain: {
        height: 2159003,
        fee_address: '',
        status: 'OK',
        version: '6.7.5',
        difficulty: 34100000,
        hashrate: 42,
      },
    };

    const stored = preserveProbedChain(incoming, existing);

    assert.equal(stored.version, '1.2.3');
    assert.equal(stored.blockchain.version, '6.7.5');
    assert.equal(stored.blockchain.difficulty, 34100000);
    assert.equal(stored.blockchain.hashrate, 42);
    assert.equal(stored.blockchain.height, existing.blockchain.height);
  });
});

describe('synced filter', () => {
  const hash = (height) => String(height).padStart(64, '0');
  const row = (height, tipHash, reachable = true) => ({
    status: { isReachable: reachable },
    blockchain: tipHash ? { height, tipHash } : { height },
  });
  // ring of the last 20 published tips: heights 2158984..2159003, anchor = 2159003
  const buildRing = () => {
    const ring = createAnchorRing(20);

    for (let height = 2158984; height <= 2159003; height++) {
      ring.push({ height, hash: hash(height) });
    }

    return ring;
  };

  it('keeps reachable rows inside the anchor band when no ring is known yet', () => {
    const rows = [
      row(2159003),
      row(2159001),
      row(2159005),
      row(2159000),
      row(2159006),
      row(2159103),
      row(2159003, undefined, false),
    ];

    assert.deepEqual(
      syncedNodes(rows, true, 2159003).map((rowValue) => rowValue.blockchain.height),
      [2159003, 2159001, 2159005]
    );
  });

  it('returns no synced rows when the seed anchor is missing', () => {
    const rows = [row(2159003)];

    assert.deepEqual(syncedNodes(rows, true, null), []);
    assert.deepEqual(syncedNodes(rows, false, null), rows);
  });

  it('verifies a row whose height and tip hash sit in the ring', () => {
    const ring = buildRing();
    const verified = row(2159001, hash(2159001));

    assert.deepEqual(syncedNodes([verified], true, 2159003, ring), [verified]);
    assert.equal(verified.status.syncedGrace, undefined);
  });

  it('rejects a ring-covered height with a mismatched tip hash', () => {
    const ring = buildRing();

    assert.deepEqual(syncedNodes([row(2159001, hash(2159002))], true, 2159003, ring), []);
  });

  it('rejects a ring-covered height with no tip hash at all', () => {
    const ring = buildRing();

    assert.deepEqual(syncedNodes([row(2159001)], true, 2159003, ring), []);
  });

  it('admits a height above the ring maximum inside the band under grace', () => {
    const ring = buildRing();
    const ahead = row(2159004, hash(2159004));

    assert.deepEqual(syncedNodes([ahead], true, 2159003, ring), [ahead]);
    assert.equal(ahead.status.syncedGrace, true);
  });

  it('keeps the grace window inside the upper bound', () => {
    const ring = buildRing();
    const graceTop = row(2159005, hash(2159005));
    const beyond = row(2159006, hash(2159006));

    assert.deepEqual(syncedNodes([graceTop, beyond], true, 2159003, ring), [graceTop]);
  });

  it('rejects a grace row on hash mismatch once the ring reaches its height', () => {
    const ring = buildRing();
    const grace = row(2159004, hash(2159004));

    assert.deepEqual(syncedNodes([grace], true, 2159003, ring), [grace]);

    // the real chain reached 2159004 with a different hash
    ring.push({ height: 2159004, hash: hash(2159003) });

    assert.deepEqual(syncedNodes([grace], true, 2159003, ring), []);
    assert.equal(grace.status.syncedGrace, undefined);
  });

  it('clears the grace flag once the ring verifies the claimed tip', () => {
    const ring = buildRing();
    const grace = row(2159004, hash(2159004));

    syncedNodes([grace], true, 2159003, ring);
    assert.equal(grace.status.syncedGrace, true);

    ring.push({ height: 2159004, hash: hash(2159004) });
    syncedNodes([grace], true, 2159003, ring);

    assert.equal(grace.status.syncedGrace, undefined);
  });

  it('rejects a row with a non-numeric height inside the band', () => {
    const values = [
      { status: { isReachable: true }, blockchain: {} },
      { status: { isReachable: true } },
    ];

    assert.deepEqual(syncedNodes(values, true, 2159003, buildRing()), []);
    assert.deepEqual(syncedNodes(values, true, 2159003), []);
  });
});

describe('chainVerdict', () => {
  // Measured from syncedNodes: kept heights are anchorHeight - 2 .. anchorHeight + 2.
  const bandHalf = 2;
  const anchor = 2159003;
  const hash = (height) => `Ab${String(height).padStart(62, '0')}`;
  const row = (height, tipHash) => ({
    status: { isReachable: false },
    blockchain: tipHash === undefined ? { height } : { height, tipHash },
  });

  it('returns unchecked when the anchor height is not an integer', () => {
    const value = row(anchor, hash(anchor));
    const ring = createAnchorRing(20);
    ring.push({ height: anchor, hash: hash(anchor) });

    assert.equal(chainVerdict(value, null, ring), 'unchecked');
    assert.equal(chainVerdict(value, undefined, ring), 'unchecked');
    assert.equal(chainVerdict({}, anchor + 0.5, ring), 'unchecked');
  });

  it('rejects a missing or non-finite height when the anchor is known', () => {
    const ring = createAnchorRing(20);
    ring.push({ height: anchor, hash: hash(anchor) });
    const missing = { status: { isReachable: true, syncedGrace: true }, blockchain: {} };
    const absent = { status: { isReachable: true, syncedGrace: true } };
    const junk = { status: { isReachable: true }, blockchain: { height: 'not-a-height' } };

    assert.equal(chainVerdict(missing, anchor, ring), 'reject');
    assert.equal(chainVerdict(absent, anchor, ring), 'reject');
    assert.equal(chainVerdict(junk, anchor, ring), 'reject');
    assert.equal(
      chainVerdict({ blockchain: { height: Number.POSITIVE_INFINITY } }, anchor, ring),
      'reject'
    );

    assert.deepEqual(syncedNodes([missing], true, anchor, ring), []);
    assert.equal(missing.status.syncedGrace, undefined);
    assert.deepEqual(syncedNodes([absent], true, anchor, ring), []);
    assert.equal(absent.status.syncedGrace, undefined);
  });

  it('rejects a height outside the anchor band even when the ring is empty', () => {
    const empty = createAnchorRing(20);
    const above = anchor + bandHalf + 1;
    const below = anchor - bandHalf - 1;
    const ring = createAnchorRing(20);
    ring.push({ height: anchor, hash: hash(anchor) });
    const outside = {
      status: { isReachable: true, syncedGrace: true },
      blockchain: { height: above, tipHash: hash(above) },
    };

    assert.ok(above > ring.entries()[ring.entries().length - 1].height);
    assert.equal(chainVerdict(row(above, hash(above)), anchor, empty), 'reject');
    assert.equal(chainVerdict(row(below, hash(below)), anchor, empty), 'reject');
    assert.equal(chainVerdict(row(above, hash(above)), anchor, ring), 'reject');
    assert.deepEqual(syncedNodes([outside], true, anchor, empty), []);
    assert.equal(outside.status.syncedGrace, undefined);
  });

  it('returns unchecked for an in-band height when the ring is empty', () => {
    const empty = createAnchorRing(20);
    const high = anchor + bandHalf;
    const low = anchor - bandHalf;
    const listed = {
      status: { isReachable: true, syncedGrace: true },
      blockchain: { height: anchor, tipHash: hash(anchor) },
    };

    assert.equal(chainVerdict(row(anchor, hash(anchor)), anchor, empty), 'unchecked');
    assert.equal(chainVerdict(row(high), anchor, undefined), 'unchecked');
    assert.equal(chainVerdict(row(low), anchor, {}), 'unchecked');
    assert.deepEqual(syncedNodes([listed], true, anchor, empty), [listed]);
    assert.equal(listed.status.syncedGrace, undefined);
  });

  it('verifies a hash that matches the ring entry for that height', () => {
    const ring = createAnchorRing(20);
    const claimed = hash(anchor);
    ring.push({ height: anchor, hash: claimed });
    const stored = ring.entries().find((entry) => entry.height === anchor).hash;
    const offline = row(anchor, claimed);
    offline.status.isReachable = false;

    assert.equal(stored, claimed.toLowerCase());
    assert.notEqual(claimed, stored);
    assert.equal(chainVerdict(offline, anchor, ring), 'verified');
  });

  it('returns grace when the height is above the last ring entry and inside the band', () => {
    // Ring maximum is the last published entry, not the numeric max of the entries.
    const ring = createAnchorRing(20);
    const numericMax = anchor + bandHalf;
    const lastPublished = anchor;
    const between = lastPublished + 1;
    const claimed = hash(between);

    assert.equal(bandHalf >= 2, true);
    assert.ok(between < numericMax);
    assert.ok(between <= anchor + bandHalf);
    ring.push({ height: numericMax, hash: hash(numericMax) });
    ring.push({ height: lastPublished, hash: hash(lastPublished) });

    const entries = ring.entries();
    assert.equal(entries[entries.length - 1].height, lastPublished);
    assert.notEqual(claimed.toLowerCase(), hash(numericMax).toLowerCase());
    assert.equal(
      entries.some((entry) => entry.height === between),
      false
    );
    assert.equal(chainVerdict(row(between, claimed), anchor, ring), 'grace');
  });

  it('rejects a covered height whose hash is missing or different', () => {
    const ring = createAnchorRing(20);
    ring.push({ height: anchor - 1, hash: hash(anchor - 1) });
    ring.push({ height: anchor, hash: hash(anchor) });
    const entries = ring.entries();
    const last = entries[entries.length - 1].height;
    const wrong = hash(anchor + 1);
    const gap = anchor - bandHalf;
    const mismatched = {
      status: { isReachable: true, syncedGrace: true },
      blockchain: { height: anchor, tipHash: wrong },
    };

    assert.equal(last, anchor);
    assert.notEqual(wrong.toLowerCase(), hash(anchor).toLowerCase());
    assert.equal(chainVerdict(row(anchor, wrong), anchor, ring), 'reject');
    assert.equal(chainVerdict(row(anchor), anchor, ring), 'reject');
    assert.ok(gap <= last);
    assert.equal(
      entries.some((entry) => entry.height === gap),
      false
    );
    assert.equal(chainVerdict(row(gap, hash(gap)), anchor, ring), 'reject');
    assert.deepEqual(syncedNodes([mismatched], true, anchor, ring), []);
    assert.equal(mismatched.status.syncedGrace, undefined);
  });
});

describe('applyChainGate', () => {
  const bandHalf = 2;
  const anchor = 2159003;
  const hash = (height) => `Ab${String(height).padStart(62, '0')}`;

  const createCache = (ids) => {
    const keys = new Set(ids);
    const deleted = [];

    return {
      deleted,
      keys: () => [...keys],
      del(id) {
        deleted.push(id);
        keys.delete(id);
      },
    };
  };

  const coveredRing = () => {
    const ring = createAnchorRing(20);
    ring.push({ height: anchor - 1, hash: hash(anchor - 1) });
    ring.push({ height: anchor, hash: hash(anchor) });
    return ring;
  };

  it('deletes only the mismatched id when the ring covers that height', () => {
    const ring = coveredRing();
    const wrong = hash(anchor + 1);
    const rejectedId = 'node-mismatch';
    const keptId = 'node-other';
    const cache = createCache([rejectedId, keptId]);
    const record = {
      id: rejectedId,
      status: { syncedGrace: true },
      blockchain: { height: anchor, tipHash: wrong },
    };
    const blank = {
      id: '',
      status: { syncedGrace: true },
      blockchain: { height: anchor, tipHash: wrong },
    };
    const blankCache = createCache(['', keptId]);
    const numeric = {
      id: 1,
      blockchain: { height: anchor, tipHash: wrong },
    };
    const numericCache = createCache([1, keptId]);

    assert.notEqual(wrong.toLowerCase(), hash(anchor).toLowerCase());
    assert.notEqual(rejectedId, keptId);
    assert.equal(ring.entries().at(-1).height, anchor);

    const result = applyChainGate(cache, record, anchor, ring);

    assert.deepEqual(result, { ok: false, verdict: 'reject' });
    assert.deepEqual(cache.deleted, [rejectedId]);
    assert.deepEqual(cache.keys(), [keptId]);

    assert.deepEqual(applyChainGate(blankCache, blank, anchor, ring), {
      ok: false,
      verdict: 'reject',
    });
    assert.deepEqual(blankCache.deleted, []);
    assert.deepEqual(blankCache.keys(), ['', keptId]);

    assert.deepEqual(applyChainGate(numericCache, numeric, anchor, ring), {
      ok: false,
      verdict: 'reject',
    });
    assert.deepEqual(numericCache.deleted, []);
    assert.deepEqual(numericCache.keys(), [1, keptId]);
  });

  it('keeps the listing when the reject is not a covered miss', () => {
    const ring = coveredRing();
    const syncingId = 'node-syncing';
    const aheadId = 'node-ahead';
    const gapId = 'node-gap';
    const missingId = 'node-missing';
    const keptId = 'node-kept';
    const cache = createCache([syncingId, aheadId, gapId, missingId, keptId]);
    const syncing = {
      id: syncingId,
      status: { syncedGrace: true, isReachable: true },
      blockchain: { height: anchor - 50, tipHash: hash(anchor - 50) },
    };
    const ahead = {
      id: aheadId,
      status: { isReachable: true },
      blockchain: { height: anchor + 3, tipHash: hash(anchor + 3) },
    };
    const gap = {
      id: gapId,
      status: { isReachable: true },
      blockchain: { height: anchor - bandHalf, tipHash: hash(anchor - bandHalf) },
    };
    const missing = {
      id: missingId,
      status: { isReachable: true },
      blockchain: {},
    };

    assert.equal(
      ring.entries().some((entry) => entry.height === anchor - 50),
      false
    );
    assert.equal(
      ring.entries().some((entry) => entry.height === anchor + 3),
      false
    );
    assert.equal(
      ring.entries().some((entry) => entry.height === anchor - bandHalf),
      false
    );
    assert.equal(chainVerdict(syncing, anchor, ring), 'reject');
    assert.equal(chainVerdict(ahead, anchor, ring), 'reject');
    assert.equal(chainVerdict(gap, anchor, ring), 'reject');
    assert.equal(chainVerdict(missing, anchor, ring), 'reject');

    assert.deepEqual(applyChainGate(cache, syncing, anchor, ring), {
      ok: true,
      verdict: 'reject',
    });
    assert.deepEqual(applyChainGate(cache, ahead, anchor, ring), {
      ok: true,
      verdict: 'reject',
    });
    assert.deepEqual(applyChainGate(cache, gap, anchor, ring), {
      ok: true,
      verdict: 'reject',
    });
    assert.deepEqual(applyChainGate(cache, missing, anchor, ring), {
      ok: true,
      verdict: 'reject',
    });
    assert.deepEqual(cache.deleted, []);
    assert.deepEqual(cache.keys(), [syncingId, aheadId, gapId, missingId, keptId]);
    assert.equal(syncing.status.syncedGrace, undefined);
  });

  it('clears syncedGrace when a covered mismatch rejects the row', () => {
    const ring = coveredRing();
    const wrong = hash(anchor + 1);
    const rejectedId = 'node-grace-reject';
    const keptId = 'node-kept';
    const cache = createCache([rejectedId, keptId]);
    const record = {
      id: rejectedId,
      status: { syncedGrace: true, isReachable: true },
      blockchain: { height: anchor, tipHash: wrong },
    };

    assert.notEqual(rejectedId, keptId);
    assert.notEqual(wrong.toLowerCase(), hash(anchor).toLowerCase());
    assert.equal(record.status.syncedGrace, true);
    assert.equal(ring.entries().at(-1).height, anchor);

    const result = applyChainGate(cache, record, anchor, ring);

    assert.deepEqual(result, { ok: false, verdict: 'reject' });
    assert.deepEqual(cache.deleted, [rejectedId]);
    assert.equal(cache.keys().includes(rejectedId), false);
    assert.equal(cache.keys().includes(keptId), true);
    assert.equal(record.status.syncedGrace, undefined);
  });

  it('sets syncedGrace when the height is above the last ring entry', () => {
    const ring = createAnchorRing(20);
    const numericMax = anchor + bandHalf;
    const lastPublished = anchor;
    const between = lastPublished + 1;
    ring.push({ height: numericMax, hash: hash(numericMax) });
    ring.push({ height: lastPublished, hash: hash(lastPublished) });

    const id = 'node-grace';
    const keptId = 'node-stay';
    const cache = createCache([id, keptId]);
    const record = {
      id,
      status: { isReachable: false },
      blockchain: { height: between, tipHash: hash(between) },
    };
    const bare = {
      id: 'node-bare',
      blockchain: { height: between, tipHash: hash(between) },
    };
    const primitiveStatus = {
      id: 'node-primitive',
      status: 'OK',
      blockchain: { height: between, tipHash: hash(between) },
    };

    assert.equal(bandHalf >= 2, true);
    assert.ok(between < numericMax);
    assert.ok(between <= anchor + bandHalf);
    assert.equal(ring.entries().at(-1).height, lastPublished);
    assert.equal(record.status.syncedGrace, undefined);

    const result = applyChainGate(cache, record, anchor, ring);

    assert.deepEqual(result, { ok: true, verdict: 'grace' });
    assert.equal(record.status.syncedGrace, true);
    assert.equal(record.status.isReachable, false);
    assert.deepEqual(cache.deleted, []);
    assert.deepEqual(cache.keys(), [id, keptId]);
    assert.deepEqual(applyChainGate(createCache([bare.id]), bare, anchor, ring), {
      ok: true,
      verdict: 'grace',
    });
    assert.equal(bare.status, undefined);
    assert.deepEqual(
      applyChainGate(createCache([primitiveStatus.id]), primitiveStatus, anchor, ring),
      {
        ok: true,
        verdict: 'grace',
      }
    );
    assert.equal(primitiveStatus.status, 'OK');
  });

  it('clears syncedGrace when the tip hash matches the ring', () => {
    const ring = createAnchorRing(20);
    const claimed = hash(anchor);
    ring.push({ height: anchor, hash: claimed });
    const stored = ring.entries()[0].hash;
    const id = 'node-match';
    const keptId = 'node-stay';
    const cache = createCache([id, keptId]);
    const record = {
      id,
      status: { syncedGrace: true, isReachable: false },
      blockchain: { height: anchor, tipHash: claimed },
    };

    assert.equal(stored, claimed.toLowerCase());
    assert.notEqual(claimed, stored);

    const result = applyChainGate(cache, record, anchor, ring);

    assert.deepEqual(result, { ok: true, verdict: 'verified' });
    assert.equal(record.status.syncedGrace, undefined);
    assert.equal(record.status.isReachable, false);
    assert.deepEqual(cache.deleted, []);
    assert.deepEqual(cache.keys(), [id, keptId]);
  });
});
