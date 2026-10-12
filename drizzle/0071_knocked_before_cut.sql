-- The count now leaves out doors knocked since the cut, which MiniVAN
-- already shows. Cleared so the next scheduled contact sync recounts every
-- turf (needsFullRecompute in van/contact-sync.ts).
ALTER TABLE `van_turfs` RENAME COLUMN `contacted_doors` TO `knocked_before_cut`;--> statement-breakpoint
UPDATE `van_turfs` SET `knocked_before_cut` = NULL;
