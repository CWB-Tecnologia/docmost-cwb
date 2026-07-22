import { AuditRepo } from './audit.repo';
import {
  computeAuditHash,
  computeCheckpointHash,
  GENESIS_PREV_HASH,
} from '../../../integrations/audit/audit-hash.util';

const workspaceId = '01800000-0000-7000-8000-000000000001';
const createdAt = new Date('2026-07-22T12:00:00.000Z');

function auditRow(seq: number, prevHash: string) {
  const row = {
    id: `01800000-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    workspaceId,
    actorId: null,
    actorType: 'system',
    event: 'audit.tested',
    resourceType: 'audit',
    resourceId: null,
    spaceId: null,
    changes: null,
    metadata: null,
    ipAddress: null,
    userAgent: null,
    createdAt,
    seq,
    prevHash,
    hash: '',
  };
  row.hash = computeAuditHash({
    ...row,
    createdAt: createdAt.toISOString(),
  });
  return row;
}

function checkpoint(upToSeq: number, upToHash: string, rowCount = upToSeq) {
  const sealedAt = new Date('2026-07-22T11:00:00.000Z');
  const value = {
    id: '01800000-0000-7000-8000-000000000099',
    workspaceId,
    upToSeq,
    upToHash,
    rowCount,
    prevCheckpointHash: GENESIS_PREV_HASH,
    checkpointHash: '',
    sealedAt,
  };
  value.checkpointHash = computeCheckpointHash({
    ...value,
    sealedAt: sealedAt.toISOString(),
  });
  return value;
}

function mockDb(checkpoints: unknown[], rows: unknown[]) {
  const auditWhereCalls: unknown[][] = [];
  const selectFrom = jest.fn((table: string) => {
    const query: Record<string, jest.Mock> = {};
    query.selectAll = jest.fn(() => query);
    query.where = jest.fn((...args: unknown[]) => {
      if (table === 'audit') auditWhereCalls.push(args);
      return query;
    });
    query.orderBy = jest.fn(() => query);
    query.execute = jest.fn(async () =>
      table === 'auditCheckpoint' ? checkpoints : rows,
    );
    return query;
  });

  return { db: { selectFrom }, auditWhereCalls };
}

describe('AuditRepo.verifyChain', () => {
  it('walks forward from the prior checkpoint for a later requested range', async () => {
    const sealed = checkpoint(3, 'sealed-row-3');
    const row4 = auditRow(4, sealed.upToHash);
    const row5 = auditRow(5, row4.hash);
    const { db, auditWhereCalls } = mockDb([sealed], [row4, row5]);
    const repo = new AuditRepo(db as any);

    const result = await repo.verifyChain(workspaceId, { fromSeq: 5 });

    expect(result).toMatchObject({
      ok: true,
      checked: 2,
      fromSeq: 4,
      toSeq: 5,
    });
    expect(auditWhereCalls).toContainEqual(['seq', '>=', 4]);
  });

  it('detects a missing first row in an unanchored partial range', async () => {
    const row6 = auditRow(6, 'trusted-local-anchor');
    const { db } = mockDb([], [row6]);
    const repo = new AuditRepo(db as any);

    const result = await repo.verifyChain(workspaceId, { fromSeq: 5 });

    expect(result).toMatchObject({
      ok: false,
      firstBrokenSeq: 5,
      reason: 'seq_gap',
    });
  });

  it('rejects a checkpoint whose row count does not cover its sequence window', async () => {
    const malformed = checkpoint(3, 'sealed-row-3', 2);
    const { db } = mockDb([malformed], []);
    const repo = new AuditRepo(db as any);

    const result = await repo.verifyChain(workspaceId);

    expect(result).toMatchObject({
      ok: false,
      firstBrokenCheckpointSeq: 3,
      reason: 'checkpoint_row_count_mismatch',
    });
  });
});
