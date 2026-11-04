-- studio#113. Resolving a directive or link by id alone (`transclusion.ts`)
-- looks an imported item up by remote_id, which the primary key
-- (subscription_id, remote_id) cannot serve, so every lookup scanned the table.
CREATE INDEX imported_items_remote ON imported_items(remote_id, subscription_id);

-- The reader inbox lists each row's hoppers in a correlated subquery keyed on
-- (subscription_id, remote_id). The primary key leads with hopper_id, so the
-- subquery scanned hopper_items once per row on every page.
CREATE INDEX hopper_items_member ON hopper_items(subscription_id, remote_id, hopper_id);
