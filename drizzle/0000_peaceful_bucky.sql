CREATE TABLE `conversations` (
	`chat_id` text PRIMARY KEY NOT NULL,
	`data` blob NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`object_key` text NOT NULL,
	`file_name` text NOT NULL,
	`transcript_object_key` text,
	`transcript_preview` text,
	`error_code` text,
	`error_message` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`meta` blob
);
--> statement-breakpoint
CREATE TABLE `user_entitlements` (
	`user_id` text PRIMARY KEY NOT NULL,
	`plan` text,
	`status` text,
	`expires_at` text,
	`features` blob NOT NULL,
	`limits` blob NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
