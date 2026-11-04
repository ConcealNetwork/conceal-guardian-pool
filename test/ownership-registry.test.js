const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createOwnershipRegistry, pendingClaimGraceMs } = require('../ownership-registry');

const keyA = 'aa'.repeat(32);
const keyB = 'bb'.repeat(32);
const id = '550e8400-e29b-41d4-a716-446655440000';

describe('ownership registry', () => {
  it('claims an unclaimed id once and refuses the concurrent second claim', () => {
    const registry = createOwnershipRegistry();

    assert.equal(registry.claimForUpdate(id, keyA), true);
    // second concurrent signed submission with a different key must lose
    assert.equal(registry.claimForUpdate(id, keyB), false);
    assert.equal(registry.claims.get(id), keyA);
    assert.equal(registry.pending.has(id), true);
  });

  it('rolls a failed registration back so the id stays registrable', () => {
    const registry = createOwnershipRegistry();

    registry.claimForUpdate(id, keyA);
    registry.release(id, keyA);

    assert.equal(registry.claims.has(id), false);
    assert.equal(registry.pending.has(id), false);
    assert.equal(registry.claimForUpdate(id, keyB), true);
  });

  it('never drops another key claim on release', () => {
    const registry = createOwnershipRegistry();

    registry.claimForUpdate(id, keyA);
    registry.release(id, keyB);

    assert.equal(registry.claims.get(id), keyA);
    assert.equal(registry.pending.has(id), true);
  });

  it('confirms a reservation and clears the in-flight protection', () => {
    const registry = createOwnershipRegistry();

    registry.claimForUpdate(id, keyA);
    registry.confirm(id, keyA);

    assert.equal(registry.claims.get(id), keyA);
    assert.equal(registry.pending.has(id), false);
  });

  it('reconciles away claims whose listing expired or was evicted', () => {
    const registry = createOwnershipRegistry();

    registry.claimForUpdate('id-1', keyA, 1000);
    registry.claimForUpdate('id-2', keyB, 1000);
    registry.reconcile(new Set(['id-2']), 1000 + pendingClaimGraceMs);

    assert.equal(registry.claims.has('id-1'), false);
    assert.equal(registry.claims.has('id-2'), true);
    assert.equal(registry.pending.size, 0);
  });

  it('protects in-flight reservations and reaps abandoned ones after the grace period', () => {
    const registry = createOwnershipRegistry();

    registry.claimForUpdate(id, keyA, 1000);

    // within the grace period the reservation survives an empty cache
    registry.reconcile(new Set(), 1000 + pendingClaimGraceMs - 1);
    assert.equal(registry.claims.has(id), true);

    // after the grace period an abandoned reservation is fully reaped
    registry.reconcile(new Set(), 1000 + pendingClaimGraceMs);
    assert.equal(registry.claims.has(id), false);
    assert.equal(registry.pending.has(id), false);
  });

  it('keeps the registry bounded to the live cache across reconciles', () => {
    const registry = createOwnershipRegistry();

    for (let i = 0; i < 50; i++) {
      registry.claimForUpdate(`id-${i}`, keyA, 1000);
    }

    // only five listings survived their TTL; the in-flight protection is
    // spent for all of them at the grace boundary
    registry.reconcile(
      new Set(['id-0', 'id-1', 'id-2', 'id-3', 'id-4']),
      1000 + pendingClaimGraceMs
    );

    assert.equal(registry.claims.size, 5);
    assert.equal(registry.pending.size, 0);
  });
});
