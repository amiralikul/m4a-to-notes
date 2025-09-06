CREATE TABLE `transcriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`audio_key` text NOT NULL,
	`filename` text NOT NULL,
	`source` text NOT NULL,
	`transcript_text` text,
	`transcript_key` text,
	`preview` text,
	`user_metadata` text,
	`error_details` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`started_at` text,
	`completed_at` text,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
