-- WITHOUT ROWID, which drizzle-kit cannot declare (see schema.ts): the rows
-- live in the primary key's own B-tree, so a lookup by person finds the date
-- in the same page as the key — one scattered read per roster row in every
-- count, not a key lookup followed by a table read.
CREATE TABLE `__new_van_person_contacts` (
	`campaign_id` integer DEFAULT 1 NOT NULL,
	`person_hash` blob NOT NULL,
	`last_in_person_at` text NOT NULL,
	PRIMARY KEY(`campaign_id`, `person_hash`)
) WITHOUT ROWID;--> statement-breakpoint
INSERT INTO `__new_van_person_contacts` (`campaign_id`, `person_hash`, `last_in_person_at`)
SELECT `campaign_id`, `person_hash`, `last_in_person_at` FROM `van_person_contacts`;--> statement-breakpoint
DROP TABLE `van_person_contacts`;--> statement-breakpoint
ALTER TABLE `__new_van_person_contacts` RENAME TO `van_person_contacts`;--> statement-breakpoint
CREATE INDEX `van_person_contacts_campaign_at` ON `van_person_contacts` (`campaign_id`,`last_in_person_at`);
