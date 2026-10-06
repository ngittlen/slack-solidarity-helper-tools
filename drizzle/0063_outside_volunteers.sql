CREATE TABLE `outside_volunteers` (
	`user_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`email` text NOT NULL,
	`is_private_email` integer DEFAULT false NOT NULL,
	`display_name` text,
	`first_signed_in_at` text NOT NULL,
	`last_signed_in_at` text NOT NULL
);
--> statement-breakpoint
-- Hand-added: carry every Google record across. 'Google volunteer' was spec
-- 013's placeholder for a profile with no usable name; it becomes NULL, so
-- that volunteer is asked for a name on /turfs instead (014 FR-011c).
INSERT INTO `outside_volunteers` (`user_id`, `provider`, `email`, `is_private_email`, `display_name`, `first_signed_in_at`, `last_signed_in_at`)
SELECT `user_id`, 'google', `email`, 0, NULLIF(`display_name`, 'Google volunteer'), `first_signed_in_at`, `last_signed_in_at`
FROM `google_volunteers`;
