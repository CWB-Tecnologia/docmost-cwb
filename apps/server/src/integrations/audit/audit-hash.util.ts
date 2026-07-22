import { createHash } from 'crypto';

/**
 * Shared, dependency-free hashing for the tamper-evident audit chain.
 *
 * The same functions are used by the append path (DbAuditService/AuditRepo),
 * the verifier, and the backfill migration, so they MUST stay in sync. Any
 * change to the canonical form or the hash formula invalidates every existing
 * chain, so treat this file as an on-disk format definition, not ordinary code.
 */

export const GENESIS_PREV_HASH = '';

export interface AuditHashInput {
  workspaceId: string;
  seq: number;
  prevHash: string;
  actorId?: string | null;
  actorType: string;
  event: string;
  resourceType: string;
  resourceId?: string | null;
  spaceId?: string | null;
  changes?: unknown;
  metadata?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: string; // ISO 8601, UTC, millisecond precision
}

/** Recursively key-sorted JSON so semantically equal payloads hash identically. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined) continue;
      out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

/**
 * hash = sha256(seq \n prevHash \n canonical(content)). Binding prevHash chains
 * each row to its predecessor, so altering any earlier row breaks every hash
 * after it. seq is an explicit input and is additionally protected by the
 * unique (workspace_id, seq) constraint, which blocks gaps and reordering.
 */
export function computeAuditHash(input: AuditHashInput): string {
  const content = canonicalize({
    workspaceId: input.workspaceId,
    actorId: input.actorId ?? null,
    actorType: input.actorType,
    event: input.event,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    spaceId: input.spaceId ?? null,
    changes: input.changes ?? null,
    metadata: input.metadata ?? null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    createdAt: input.createdAt,
  });

  return createHash('sha256')
    .update(`${input.seq}\n${input.prevHash}\n${content}`)
    .digest('hex');
}

/** Chained hash for a sealed retention checkpoint (see AuditRepo.purgeOlderThan). */
export function computeCheckpointHash(input: {
  workspaceId: string;
  upToSeq: number;
  upToHash: string;
  rowCount: number;
  prevCheckpointHash: string;
  sealedAt: string;
}): string {
  const content = canonicalize({
    workspaceId: input.workspaceId,
    upToSeq: input.upToSeq,
    upToHash: input.upToHash,
    rowCount: input.rowCount,
    prevCheckpointHash: input.prevCheckpointHash,
    sealedAt: input.sealedAt,
  });

  return createHash('sha256')
    .update(`${input.prevCheckpointHash}\n${content}`)
    .digest('hex');
}
