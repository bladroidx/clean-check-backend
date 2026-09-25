-- A pending order for a given IMEI/service pair, found without a table scan -- what
-- `OrderRepo.openForImei` relies on so a second check for the same device attaches to the job
-- already running instead of buying it twice.
--
-- Locks: built CONCURRENTLY, which cannot run inside a transaction -- hence `transaction:false`
-- on both directions of this migration. Safe on a live database; takes no lock that blocks reads
-- or writes on `provider_orders`.

-- migrate:up transaction:false
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_provider_orders_open_imei
  ON provider_orders (imei_hash, service_id) WHERE status = 'pending';
-- migrate:down transaction:false
DROP INDEX CONCURRENTLY IF EXISTS idx_provider_orders_open_imei;
