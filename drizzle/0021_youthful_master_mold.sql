CREATE TABLE `sync_locks` (
	`name` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`acquired_at` text NOT NULL,
	`expires_at` text NOT NULL
);
