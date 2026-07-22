import {
  canonicalize,
  computeAuditHash,
  computeCheckpointHash,
  GENESIS_PREV_HASH,
} from './audit-hash.util';

describe('audit hash utilities', () => {
  const event = {
    workspaceId: '01900000-0000-7000-8000-000000000001',
    seq: 1,
    prevHash: GENESIS_PREV_HASH,
    actorId: '01900000-0000-7000-8000-000000000002',
    actorType: 'user',
    event: 'user.updated',
    resourceType: 'user',
    resourceId: '01900000-0000-7000-8000-000000000003',
    spaceId: null,
    changes: { after: { role: 'admin', active: true } },
    metadata: { source: 'test' },
    ipAddress: '127.0.0.1',
    userAgent: 'jest',
    createdAt: '2026-07-22T12:00:00.000Z',
  };

  it('canonicalizes nested object keys deterministically', () => {
    expect(canonicalize({ z: 1, a: { y: 2, x: 3 } })).toBe(
      '{"a":{"x":3,"y":2},"z":1}',
    );
    expect(canonicalize({ a: { x: 3, y: 2 }, z: 1 })).toBe(
      canonicalize({ z: 1, a: { y: 2, x: 3 } }),
    );
  });

  it('produces a stable hash and binds every integrity field', () => {
    const hash = computeAuditHash(event);
    expect(hash).toHaveLength(64);
    expect(computeAuditHash({ ...event })).toBe(hash);
    expect(computeAuditHash({ ...event, userAgent: 'tampered' })).not.toBe(
      hash,
    );
    expect(computeAuditHash({ ...event, prevHash: '0'.repeat(64) })).not.toBe(
      hash,
    );
  });

  it('chains checkpoints through the previous checkpoint hash', () => {
    const first = computeCheckpointHash({
      workspaceId: event.workspaceId,
      upToSeq: 10,
      upToHash: 'a'.repeat(64),
      rowCount: 10,
      prevCheckpointHash: GENESIS_PREV_HASH,
      sealedAt: event.createdAt,
    });
    const second = computeCheckpointHash({
      workspaceId: event.workspaceId,
      upToSeq: 20,
      upToHash: 'b'.repeat(64),
      rowCount: 10,
      prevCheckpointHash: first,
      sealedAt: event.createdAt,
    });

    expect(first).toHaveLength(64);
    expect(second).toHaveLength(64);
    expect(second).not.toBe(first);
    expect(
      computeCheckpointHash({
        workspaceId: event.workspaceId,
        upToSeq: 20,
        upToHash: 'b'.repeat(64),
        rowCount: 10,
        prevCheckpointHash: 'c'.repeat(64),
        sealedAt: event.createdAt,
      }),
    ).not.toBe(second);
  });
});
