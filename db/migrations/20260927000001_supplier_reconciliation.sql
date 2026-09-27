-- Supplier reconciliation: the real prepaid balance, and services switched off after a reprice.
--
-- Every provider_calls.provider_cost_usd is the catalogue price we checked in, so our books can
-- only ever agree with themselves. These two tables are how the worker notices when the supplier
-- disagrees (see apps/worker/src/jobs/reconcile-balance.ts and catalogue-drift.ts).
--
-- Locks: CREATE on tables that do not yet exist. Safe on a live database.

-- migrate:up

-- One row per successful `accountinfo` read. Carries no IMEI, hash or check id -- only money.
CREATE TABLE provider_balance_snapshots (
  id           bigserial PRIMARY KEY,
  provider_id  text NOT NULL,
  balance_usd  numeric(12,4) NOT NULL,
  taken_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_provider_balance_snapshots_latest
  ON provider_balance_snapshots (provider_id, taken_at DESC);

-- A row here means "do not buy this service", on top of the YAML. Written only by the drift job,
-- removed only by a human (scripts/service-override.mjs) once the catalogue has been repriced.
CREATE TABLE provider_service_overrides (
  provider_id          text NOT NULL,
  service_id           text NOT NULL,
  reason               text NOT NULL
    CHECK (reason IN ('price_increased', 'missing_from_supplier_list')),
  catalogue_price_usd  numeric(10,4) NOT NULL,
  live_price_usd       numeric(10,4),          -- NULL when the service vanished from the list
  detected_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, service_id)
);

-- migrate:down

DROP TABLE IF EXISTS provider_service_overrides;
DROP TABLE IF EXISTS provider_balance_snapshots;
