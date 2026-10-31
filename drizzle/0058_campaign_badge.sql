-- Per-campaign badge text (specs/012-multi-van-campaigns, Phase 6): what
-- volunteers see beside a turf while more than one campaign is enabled, and on
-- a disabled campaign's turf still being walked. Null falls back to the
-- campaign's label, then its credential key.
ALTER TABLE `van_campaigns` ADD `badge_label` text;
