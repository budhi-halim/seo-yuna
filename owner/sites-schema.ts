import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const appConfig = sqliteTable('app_config', {
  id: text('id').primaryKey(),
  payload: text('payload').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, table => [check('app_config_singleton', sql`${table.id} = 'github_app'`)]);

export const oauthStates = sqliteTable('oauth_states', {
  stateHash: text('state_hash').primaryKey(),
  kind: text('kind').notNull(),
  payload: text('payload').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, table => [index('oauth_states_expiry').on(table.expiresAt)]);

export const sessions = sqliteTable('sessions', {
  sessionHash: text('session_hash').primaryKey(),
  payload: text('payload').notNull(),
  ownerId: integer('owner_id').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, table => [index('sessions_expiry').on(table.expiresAt)]);

export const stagedUploads = sqliteTable('staged_uploads', {
  blobSha: text('blob_sha').primaryKey(),
  digest: text('digest').notNull(),
  ownerId: integer('owner_id').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const importRequests = sqliteTable('import_requests', {
  requestId: text('request_id').primaryKey(),
  blobSha: text('blob_sha').notNull(),
  digest: text('digest').notNull(),
  ownerId: integer('owner_id').notNull(),
  state: text('state').notNull(),
  runId: integer('run_id'),
  createdAt: integer('created_at').notNull(),
}, table => [check('import_requests_state', sql`${table.state} IN ('pending', 'accepted', 'unknown', 'rejected')`)]);
