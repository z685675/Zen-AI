ALTER TABLE `sessions` ADD `is_pinned` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `is_archived` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_sessions_is_pinned` ON `sessions` (`is_pinned`);
--> statement-breakpoint
CREATE INDEX `idx_sessions_is_archived` ON `sessions` (`is_archived`);
