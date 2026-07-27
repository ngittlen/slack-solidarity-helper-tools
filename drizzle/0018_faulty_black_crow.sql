CREATE TABLE `mobilize_synced_rsvps` (
	`mobilize_attendance_id` integer PRIMARY KEY NOT NULL,
	`solidarity_rsvp_id` integer,
	`solidarity_user_id` integer NOT NULL,
	`solidarity_session_id` integer NOT NULL,
	`status` text NOT NULL,
	`attended` integer DEFAULT false NOT NULL,
	`mobilize_modified_date` integer DEFAULT 0 NOT NULL,
	`synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mobilize_synced_timeslots` (
	`mobilize_timeslot_id` integer PRIMARY KEY NOT NULL,
	`mobilize_event_id` integer NOT NULL,
	`solidarity_event_id` integer NOT NULL,
	`solidarity_session_id` integer NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `zip_chapter_map` (
	`zip_code` text PRIMARY KEY NOT NULL,
	`chapter_id` integer NOT NULL,
	`member_count` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
