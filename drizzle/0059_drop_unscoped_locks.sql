-- The catalog and contact locks became one per campaign
-- (`van-catalog-sync:<id>`, `van-contact-sync:<id>`; specs/012-multi-van-campaigns).
-- A row under the old, unscoped name is left over from before the deploy: no
-- code takes it any more, so it would only ever expire — and meanwhile be listed
-- by `npm run van:geometry` as a lock someone holds. Deleting it frees nothing a
-- running process depends on: a sync still holding it finishes on its own.
DELETE FROM `sync_locks` WHERE `name` IN ('van-catalog-sync', 'van-contact-sync');
