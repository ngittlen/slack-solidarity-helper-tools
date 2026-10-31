-- `map_route_id` → `turf_id` on the turf table and the three that reference it
-- (specs/012-multi-van-campaigns/spec.md).
--
-- A rename only: every value stays what it was, so ids already handed out —
-- Slack buttons, VAN export webhook URLs — still resolve. The column holds VAN's
-- route id today; a later migration gives VAN's id its own column so turf from
-- several campaigns can share this one.
--
-- RENAME COLUMN rewrites the indexes that name the column, including the
-- partial unique index that keeps one active checkout per turf, so nothing is
-- rebuilt.
ALTER TABLE `van_turfs` RENAME COLUMN `map_route_id` TO `turf_id`;--> statement-breakpoint
ALTER TABLE `van_turf_checkouts` RENAME COLUMN `map_route_id` TO `turf_id`;--> statement-breakpoint
ALTER TABLE `van_geometry_queue` RENAME COLUMN `map_route_id` TO `turf_id`;--> statement-breakpoint
ALTER TABLE `van_turf_roster` RENAME COLUMN `map_route_id` TO `turf_id`;
