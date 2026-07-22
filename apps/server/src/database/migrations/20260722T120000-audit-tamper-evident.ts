import { Kysely, sql } from 'kysely';
import { computeAuditHash } from '../../integrations/audit/audit-hash.util';

// NOTE: the migration runner (migrate.ts) uses a plain Kysely<any> WITHOUT the
// CamelCasePlugin, so every column here is referenced in snake_case.

export async function up(db: Kysely<any>): Promise<void> {
  // 1. Hash-chain columns, nullable at first so we can backfill existing rows.
  await db.schema
    .alterTable('audit')
    .addColumn('seq', 'int8', (col) => col)
    .addColumn('prev_hash', 'varchar(64)', (col) => col)
    .addColumn('hash', 'varchar(64)', (col) => col)
    .addColumn('user_agent', 'text', (col) => col)
    .execute();

  // 2. Backfill: build a per-workspace chain over whatever rows already exist,
  //    ordered deterministically. (In practice the CE NoopAuditService never
  //    wrote any, so this is usually a no-op, but keep it correct regardless.)
  const rows = await db
    .selectFrom('audit')
    .select([
      'id',
      'workspace_id',
      'actor_id',
      'actor_type',
      'event',
      'resource_type',
      'resource_id',
      'space_id',
      'changes',
      'metadata',
      'ip_address',
      'user_agent',
      'created_at',
    ])
    .orderBy('workspace_id')
    .orderBy('created_at')
    .orderBy('id')
    .execute();

  const seqByWs = new Map<string, number>();
  const prevHashByWs = new Map<string, string>();

  for (const r of rows) {
    const wsId = r.workspace_id as string;
    const seq = (seqByWs.get(wsId) ?? 0) + 1;
    const prevHash = prevHashByWs.get(wsId) ?? '';
    const createdAt =
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : new Date(r.created_at).toISOString();

    const hash = computeAuditHash({
      workspaceId: wsId,
      seq,
      prevHash,
      actorId: r.actor_id,
      actorType: r.actor_type,
      event: r.event,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      spaceId: r.space_id,
      changes: r.changes,
      metadata: r.metadata,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
      createdAt,
    });

    await db
      .updateTable('audit')
      .set({ seq, prev_hash: prevHash, hash })
      .where('id', '=', r.id)
      .execute();

    seqByWs.set(wsId, seq);
    prevHashByWs.set(wsId, hash);
  }

  // 3. Lock the chain columns down now that they are populated.
  await sql`ALTER TABLE audit ALTER COLUMN seq SET NOT NULL`.execute(db);
  await sql`ALTER TABLE audit ALTER COLUMN prev_hash SET NOT NULL`.execute(db);
  await sql`ALTER TABLE audit ALTER COLUMN hash SET NOT NULL`.execute(db);

  // 4. Integrity constraints: contiguous per-workspace sequence, no hash reuse,
  //    fast tail lookup.
  await db.schema
    .createIndex('audit_workspace_seq_unique')
    .unique()
    .on('audit')
    .columns(['workspace_id', 'seq'])
    .execute();

  await db.schema
    .createIndex('audit_workspace_hash_unique')
    .unique()
    .on('audit')
    .columns(['workspace_id', 'hash'])
    .execute();

  await db.schema
    .createIndex('audit_workspace_seq_desc_idx')
    .on('audit')
    .columns(['workspace_id', 'seq desc'])
    .execute();

  // 5. Append-only guard: block in-place edits (the most likely app-level
  //    tamper). DELETE is intentionally still allowed for retention purges,
  //    which are made provable by sealed checkpoints (see audit_checkpoint).
  //    A DBA can disable this trigger, so the hash chain remains the real
  //    integrity guarantee; this only stops casual/application tampering.
  await sql`
    CREATE OR REPLACE FUNCTION audit_block_update() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit rows are append-only and cannot be updated';
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  await sql`
    CREATE TRIGGER audit_no_update
    BEFORE UPDATE ON audit
    FOR EACH ROW EXECUTE FUNCTION audit_block_update();
  `.execute(db);

  // 6. Sealed retention checkpoints. Before a purge deletes [min..upToSeq], the
  //    tail hash of the deleted window is recorded here, so verification can
  //    resume from the checkpoint and the deletion stays tamper-evident.
  await db.schema
    .createTable('audit_checkpoint')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('up_to_seq', 'int8', (col) => col.notNull())
    .addColumn('up_to_hash', 'varchar(64)', (col) => col.notNull())
    .addColumn('row_count', 'int8', (col) => col.notNull())
    .addColumn('prev_checkpoint_hash', 'varchar(64)', (col) => col.notNull())
    .addColumn('checkpoint_hash', 'varchar(64)', (col) => col.notNull())
    .addColumn('sealed_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex('audit_checkpoint_workspace_idx')
    .on('audit_checkpoint')
    .columns(['workspace_id', 'up_to_seq desc'])
    .execute();

  await db.schema
    .createIndex('audit_checkpoint_workspace_seq_unique')
    .unique()
    .on('audit_checkpoint')
    .columns(['workspace_id', 'up_to_seq'])
    .execute();

  await db.schema
    .createIndex('audit_checkpoint_workspace_hash_unique')
    .unique()
    .on('audit_checkpoint')
    .columns(['workspace_id', 'checkpoint_hash'])
    .execute();

  await sql`
    CREATE TRIGGER audit_checkpoint_no_update
    BEFORE UPDATE ON audit_checkpoint
    FOR EACH ROW EXECUTE FUNCTION audit_block_update();
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS audit_checkpoint_no_update ON audit_checkpoint`.execute(
    db,
  );
  await sql`DROP TRIGGER IF EXISTS audit_no_update ON audit`.execute(db);
  await sql`DROP FUNCTION IF EXISTS audit_block_update()`.execute(db);

  await db.schema.dropTable('audit_checkpoint').ifExists().execute();

  await db.schema
    .dropIndex('audit_workspace_seq_desc_idx')
    .ifExists()
    .execute();
  await db.schema.dropIndex('audit_workspace_hash_unique').ifExists().execute();
  await db.schema.dropIndex('audit_workspace_seq_unique').ifExists().execute();

  await db.schema
    .alterTable('audit')
    .dropColumn('hash')
    .dropColumn('prev_hash')
    .dropColumn('seq')
    .dropColumn('user_agent')
    .execute();
}
