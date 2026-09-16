-- Remove account management: the credit ledger, the enumeration abuse ladder, and outbound
-- webhooks. This service now runs single-consumer (one seeded tenant/API key) with billing
-- permanently off -- there is no "on" state left to gate, so the tables that only ever served
-- that subsystem come out rather than sit unused. `tenants`/`api_keys` (auth) and every
-- operational/audit table (`checks`, `check_sections`, `provider_calls`, `cache_entries`,
-- `idempotency_records`, `provider_orders`) are untouched.
--
-- Locks: every statement is a DROP on tables this deployment no longer writes to. Safe on a live
-- database.

-- migrate:up

DROP TABLE IF EXISTS webhook_deliveries;
DROP TABLE IF EXISTS webhook_endpoints;
DROP TABLE IF EXISTS tenant_restrictions;
DROP TABLE IF EXISTS enumeration_buckets;
DROP TRIGGER IF EXISTS credit_ledger_no_mutation ON credit_ledger;
DROP FUNCTION IF EXISTS credit_ledger_is_append_only();
DROP TABLE IF EXISTS credit_ledger;
DROP TABLE IF EXISTS credit_accounts;

-- migrate:down

CREATE TABLE credit_accounts (
  tenant_id        text PRIMARY KEY REFERENCES tenants(id),
  balance_credits  bigint NOT NULL DEFAULT 0,
  reserved_credits bigint NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reserved_never_exceeds_balance CHECK (reserved_credits <= balance_credits)
);

CREATE TABLE credit_ledger (
  id               bigserial PRIMARY KEY,
  tenant_id        text NOT NULL REFERENCES tenants(id),
  delta            bigint NOT NULL,
  reason           text NOT NULL,
  check_id         text,
  balance_after    bigint NOT NULL,
  idempotency_key  text UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_credit_ledger_tenant ON credit_ledger (tenant_id, created_at DESC);

CREATE FUNCTION credit_ledger_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER credit_ledger_no_mutation
  BEFORE UPDATE OR DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_is_append_only();

CREATE TABLE webhook_endpoints (
  id           text PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants(id),
  url          text NOT NULL,
  secret       text NOT NULL,
  events       text[] NOT NULL DEFAULT '{check.completed}',
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_webhook_endpoints_tenant ON webhook_endpoints (tenant_id) WHERE active;

CREATE TABLE webhook_deliveries (
  id            text PRIMARY KEY,
  endpoint_id   text NOT NULL REFERENCES webhook_endpoints(id),
  check_id      text NOT NULL,
  event         text NOT NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL,
  attempts      int NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  last_status   int,
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz
);
CREATE INDEX idx_webhook_deliveries_pending ON webhook_deliveries (next_retry_at)
  WHERE status = 'pending';

CREATE TABLE enumeration_buckets (
  tenant_id   text NOT NULL REFERENCES tenants(id),
  tac         text NOT NULL,
  bucket      smallint NOT NULL,
  window_start timestamptz NOT NULL,
  hits        int NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, tac, bucket, window_start)
);
CREATE INDEX idx_enumeration_window ON enumeration_buckets (tenant_id, window_start);

CREATE TABLE tenant_restrictions (
  tenant_id   text PRIMARY KEY REFERENCES tenants(id),
  level       text NOT NULL DEFAULT 'none',
  reason      text,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz
);
