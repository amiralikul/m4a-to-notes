ALTER TABLE `conversations` ALTER COLUMN "data" TO "data" text NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ALTER COLUMN "meta" TO "meta" text;--> statement-breakpoint
ALTER TABLE `user_entitlements` ALTER COLUMN "features" TO "features" text NOT NULL;--> statement-breakpoint
ALTER TABLE `user_entitlements` ALTER COLUMN "limits" TO "limits" text NOT NULL;