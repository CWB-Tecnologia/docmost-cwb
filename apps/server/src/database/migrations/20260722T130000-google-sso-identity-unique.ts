import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE UNIQUE INDEX auth_accounts_provider_identity_unique
    ON auth_accounts (auth_provider_id, provider_user_id)
    WHERE deleted_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .dropIndex('auth_accounts_provider_identity_unique')
    .ifExists()
    .execute();
}
