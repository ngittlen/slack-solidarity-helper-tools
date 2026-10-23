CREATE TABLE `van_turf_placement_misses` (
	`turf_id` integer PRIMARY KEY NOT NULL,
	`centroid_lat` real NOT NULL,
	`centroid_lng` real NOT NULL,
	`tried_at` text NOT NULL
);
