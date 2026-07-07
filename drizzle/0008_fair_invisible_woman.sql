CREATE TABLE `channel_welcome_flags` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`show_welcome_message` integer NOT NULL,
	`last_edited_by` text NOT NULL,
	`last_edited_by_name` text NOT NULL,
	`last_edited_at` text NOT NULL
);
