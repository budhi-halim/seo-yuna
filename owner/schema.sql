CREATE TABLE `app_config` (
	`id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "app_config_singleton" CHECK("app_config"."id" = 'github_app')
);
--> statement-breakpoint
CREATE TABLE `import_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`blob_sha` text NOT NULL,
	`digest` text NOT NULL,
	`owner_id` integer NOT NULL,
	`state` text NOT NULL,
	`run_id` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "import_requests_state" CHECK("import_requests"."state" IN ('pending', 'accepted', 'unknown', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_states_expiry` ON `oauth_states` (`expires_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`session_hash` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`owner_id` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_expiry` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `staged_uploads` (
	`blob_sha` text PRIMARY KEY NOT NULL,
	`digest` text NOT NULL,
	`owner_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
