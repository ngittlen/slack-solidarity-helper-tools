PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chapter_channel_map` (
	`chapter_id` integer NOT NULL,
	`channel_id` text NOT NULL,
	`name` text NOT NULL,
	`last_edited_by` text NOT NULL,
	`last_edited_by_name` text NOT NULL,
	`last_edited_at` text NOT NULL,
	PRIMARY KEY(`chapter_id`, `channel_id`)
);
--> statement-breakpoint
INSERT INTO `__new_chapter_channel_map`("chapter_id", "channel_id", "name", "last_edited_by", "last_edited_by_name", "last_edited_at") SELECT "chapter_id", "channel_id", "name", "last_edited_by", "last_edited_by_name", "last_edited_at" FROM `chapter_channel_map`;--> statement-breakpoint
DROP TABLE `chapter_channel_map`;--> statement-breakpoint
ALTER TABLE `__new_chapter_channel_map` RENAME TO `chapter_channel_map`;--> statement-breakpoint
PRAGMA foreign_keys=ON;