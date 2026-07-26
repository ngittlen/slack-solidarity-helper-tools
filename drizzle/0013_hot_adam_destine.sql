CREATE TABLE `door_knock_refresh` (
	`id` integer PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`ok` integer,
	`error` text,
	CONSTRAINT "door_knock_refresh_singleton" CHECK("door_knock_refresh"."id" = 1)
);
