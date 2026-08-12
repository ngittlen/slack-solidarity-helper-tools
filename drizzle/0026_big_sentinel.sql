CREATE TABLE `info_commands` (
	`command` text PRIMARY KEY NOT NULL,
	`message` text NOT NULL,
	`last_edited_by` text NOT NULL,
	`last_edited_by_name` text NOT NULL,
	`last_edited_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `slack_user_tokens` (
	`slack_user_id` text PRIMARY KEY NOT NULL,
	`encrypted_token` text NOT NULL,
	`scopes` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
