-- Initial schema.
--
-- Locks: every statement here is CREATE on an empty database, so all are instant and safe.
-- Note what is absent by design: there is no raw-IMEI column anywhere, and there never will be
-- (ADR-0003). A column matching /imei/ that is not imei_hash or imei_masked is a review blocker.

-- migrate:up

CREATE TABLE tenants (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  plan            text NOT NULL DEFAULT 'free',
  status          text NOT NULL DEFAULT 'active',
  imei_salt       text NOT NULL,          -- per-tenant, so cross-tenant correlation is impossible
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 32 random bytes rendered imc_live_<base32>. Stored as sha256 plus an indexed prefix.
-- Deliberately NOT argon2: a 256-bit random key has no dictionary to defeat, so a slow KDF buys
-- nothing and costs 50ms on every request.
CREATE TABLE api_keys (
  id              text PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES tenants(id),
  prefix          text NOT NULL,
  key_sha256      text NOT NULL UNIQUE,
  scopes          text[] NOT NULL DEFAULT '{}',
  label           text,
  last_used_at    timestamptz,
  expires_at      timestamptz,
  revoked_at      timestamptz
);
CREATE INDEX idx_api_keys_prefix ON api_keys (prefix) WHERE revoked_at IS NULL;

-- credit_ledger is the truth; credit_accounts.balance is a cache written in the same transaction
-- and asserted nightly. A balance that can silently disagree with its ledger is not an accounting
-- system.
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
  -- The unique key is what makes a retried reserve a no-op instead of a double charge.
  idempotency_key  text UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_credit_ledger_tenant ON credit_ledger (tenant_id, created_at DESC);

-- Append-only, ENFORCED. A convention that only a reviewer enforces is not an accounting control.
CREATE FUNCTION credit_ledger_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER credit_ledger_no_mutation
  BEFORE UPDATE OR DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_is_append_only();

-- Partitioned so retention is a partition drop, not a DELETE that bloats and locks.
CREATE TABLE checks (
  id                      text NOT NULL,
  tenant_id               text NOT NULL,
  imei_hash               text NOT NULL,       -- HMAC(SERVER_PEPPER, digits). Never the number.
  imei_hash_version       int  NOT NULL DEFAULT 1,
  tac                     text,
  requested_capabilities  text[] NOT NULL,
  status                  text NOT NULL,
  idempotency_key         text,
  max_credits             int,
  created_at              timestamptz NOT NULL DEFAULT now(),
  completed_at            timestamptz,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE checks_default PARTITION OF checks DEFAULT;
CREATE INDEX idx_checks_imei_hash ON checks (imei_hash, created_at DESC);
CREATE UNIQUE INDEX idx_checks_idempotency ON checks (tenant_id, idempotency_key, created_at)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE check_sections (
  check_id      text NOT NULL,
  capability    text NOT NULL,
  outcome       text NOT NULL,
  reason        text,
  remedy        text,
  finding_key   text,
  severity      text,
  evidence      jsonb NOT NULL DEFAULT '[]',   -- genuinely schemaless; a status enum would not be
  coverage      jsonb NOT NULL,
  checked_at    timestamptz NOT NULL,
  cached        boolean NOT NULL DEFAULT false,
  PRIMARY KEY (check_id, capability)
);

-- Written BEFORE the HTTP call, status 'in_flight', updated after. A timeout arriving after the
-- provider already debited us is the common case; recording only on success puts the books
-- permanently behind reality.
CREATE TABLE provider_calls (
  id                 text NOT NULL,
  check_id           text,
  tenant_id          text NOT NULL,
  provider_id        text NOT NULL,
  service_id         text NOT NULL,
  capability         text NOT NULL,
  status             text NOT NULL,
  http_status        int,
  latency_ms         int,
  provider_cost_usd  numeric(10,4),
  credits_charged    int NOT NULL DEFAULT 0,
  billable           boolean NOT NULL DEFAULT true,   -- a failover leg is absorbed, not charged
  response_digest    text,
  error_code         text,
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);

CREATE TABLE provider_calls_default PARTITION OF provider_calls DEFAULT;
CREATE INDEX idx_provider_calls_tenant ON provider_calls (tenant_id, started_at DESC);

-- Cached per FIELD, not per response: one GSX call yields facts whose volatility differs by five
-- orders of magnitude (ADR-0004).
CREATE TABLE cache_entries (
  cache_key     text PRIMARY KEY,
  capability    text NOT NULL,
  field         text NOT NULL,
  payload       jsonb NOT NULL,
  coverage      jsonb NOT NULL,
  checked_at    timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  provider_id   text
);
CREATE INDEX idx_cache_expiry ON cache_entries (expires_at);

-- Own table, own ingest, never mingled with proprietary tables, so it can be swapped or purged
-- cleanly if provenance is challenged (ADR-0005).
CREATE TABLE tac_entries (
  tac              text PRIMARY KEY,
  manufacturer     text NOT NULL,
  model            text NOT NULL,
  marketing_name   text,
  source           text NOT NULL,
  source_priority  int  NOT NULL,     -- observed 100 > paid 50 > osmocom 10 > bundled 1
  source_version   text NOT NULL,
  first_seen       timestamptz NOT NULL DEFAULT now(),
  last_seen        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tac_imports (
  id           bigserial PRIMARY KEY,
  source       text NOT NULL,
  source_url   text,
  license      text,
  checksum     text,
  row_count    int,
  status       text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

-- migrate:down

DROP TABLE IF EXISTS tac_imports, tac_entries, cache_entries, check_sections;
DROP TABLE IF EXISTS provider_calls, checks;
DROP TRIGGER IF EXISTS credit_ledger_no_mutation ON credit_ledger;
DROP FUNCTION IF EXISTS credit_ledger_is_append_only();
DROP TABLE IF EXISTS credit_ledger, credit_accounts, api_keys, tenants;
