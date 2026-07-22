import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('kanban_boards')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('title', 'varchar(120)', (col) => col.notNull())
    .addColumn('space_id', 'uuid', (col) =>
      col.references('spaces.id').onDelete('cascade').notNull(),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.references('workspaces.id').onDelete('cascade').notNull(),
    )
    .addColumn('creator_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex('kanban_boards_space_idx')
    .on('kanban_boards')
    .columns(['space_id', 'created_at'])
    .execute();

  await db.schema
    .createTable('kanban_columns')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('board_id', 'uuid', (col) =>
      col.references('kanban_boards.id').onDelete('cascade').notNull(),
    )
    .addColumn('name', 'varchar(80)', (col) => col.notNull())
    .addColumn('color', 'varchar(32)')
    .addColumn('position', 'varchar(255)', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex('kanban_columns_board_position_idx')
    .on('kanban_columns')
    .columns(['board_id', 'position', 'id'])
    .execute();

  await db.schema
    .createTable('kanban_cards')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('board_id', 'uuid', (col) =>
      col.references('kanban_boards.id').onDelete('cascade').notNull(),
    )
    .addColumn('column_id', 'uuid', (col) =>
      col.references('kanban_columns.id').onDelete('cascade').notNull(),
    )
    .addColumn('title', 'varchar(200)', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('position', 'varchar(255)', (col) => col.notNull())
    .addColumn('assignee_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('priority', 'varchar(16)')
    .addColumn('due_date', 'date')
    .addColumn('labels', 'jsonb', (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .addColumn('creator_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint(
      'kanban_cards_priority_check',
      sql`priority IS NULL OR priority IN ('low', 'medium', 'high', 'urgent')`,
    )
    .execute();

  await db.schema
    .createIndex('kanban_cards_board_column_position_idx')
    .on('kanban_cards')
    .columns(['board_id', 'column_id', 'position', 'id'])
    .execute();
  await db.schema
    .createIndex('kanban_cards_assignee_idx')
    .on('kanban_cards')
    .columns(['board_id', 'assignee_id'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('kanban_cards').execute();
  await db.schema.dropTable('kanban_columns').execute();
  await db.schema.dropTable('kanban_boards').execute();
}
