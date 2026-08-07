CREATE TABLE `member_account_links` (
	`slack_user_id` text PRIMARY KEY NOT NULL,
	`solidarity_user_id` integer NOT NULL,
	`solidarity_email` text,
	`linked_by` text NOT NULL,
	`linked_by_name` text NOT NULL,
	`linked_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `member_account_links_solidarity_user_id` ON `member_account_links` (`solidarity_user_id`);--> statement-breakpoint
CREATE TABLE `member_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slack_user_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`message_link` text,
	`message_channel_id` text,
	`message_ts` text,
	`warning_number` integer,
	`dm_requested` integer DEFAULT false NOT NULL,
	`dm_sent_at` text,
	`dm_status` text,
	`dm_body` text,
	`author_slack_user_id` text NOT NULL,
	`author_slack_user_name` text NOT NULL,
	`created_at` text NOT NULL,
	`source` text DEFAULT 'slash' NOT NULL,
	CONSTRAINT "member_notes_kind_check" CHECK("member_notes"."kind" in ('note', 'warning')),
	CONSTRAINT "member_notes_source_check" CHECK("member_notes"."source" in ('slash', 'shortcut'))
);
--> statement-breakpoint
CREATE INDEX `member_notes_slack_user_created` ON `member_notes` (`slack_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `member_notes_warning_rank` ON `member_notes` (`slack_user_id`,`kind`,`id`);--> statement-breakpoint
ALTER TABLE `app_config` ADD `warning_dm_message` text;