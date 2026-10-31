-- Hand-edited: SQLite can only add a NOT NULL column with a default, and the
-- walks already there need their own random ids before the unique index.
-- New walks always get one from newPublicId (store.ts).
ALTER TABLE `mentor_walks` ADD `public_id` text NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `mentor_walks` SET `public_id` = lower(hex(randomblob(9)));--> statement-breakpoint
CREATE UNIQUE INDEX `mentor_walks_public_id` ON `mentor_walks` (`public_id`);
