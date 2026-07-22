export type IAuditActor = {
  id: string;
  name: string | null;
  email: string;
  avatarUrl?: string | null;
};

export type IAuditLog = {
  id: string;
  workspaceId: string;
  actorId?: string | null;
  actorType: string;
  event: string;
  resourceType: string;
  resourceId?: string | null;
  spaceId?: string | null;
  changes?: {
    before?: Record<string, any>;
    after?: Record<string, any>;
  } | null;
  metadata?: Record<string, any> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  seq: number;
  prevHash: string;
  hash: string;
  createdAt: string;
  actor?: IAuditActor | null;
};

export type IAuditLogParams = {
  event?: string;
  resourceType?: string;
  actorId?: string;
  spaceId?: string;
  startDate?: string;
  endDate?: string;
  cursor?: string;
  limit?: number;
};

export type IAuditRetention = { retentionDays: number };

export type AuditVerifyReason =
  | "hash_mismatch"
  | "prev_link_mismatch"
  | "seq_gap"
  | "checkpoint_hash_mismatch"
  | "checkpoint_link_mismatch"
  | "checkpoint_seq_regression"
  | "checkpoint_row_count_mismatch";

export type IAuditVerifyResult = {
  ok: boolean;
  checked: number;
  checkedCheckpoints: number;
  fromSeq: number | null;
  toSeq: number | null;
  firstBrokenSeq?: number;
  firstBrokenCheckpointSeq?: number;
  reason?: AuditVerifyReason;
};
