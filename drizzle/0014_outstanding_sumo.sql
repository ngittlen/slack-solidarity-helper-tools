CREATE TABLE `door_knock_canvasser_daily` (
	`date` text NOT NULL,
	`code` text NOT NULL,
	`canvasser` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`contacts` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`date`, `code`, `canvasser`)
);
