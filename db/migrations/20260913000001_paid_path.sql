-- The paid path: async orders, idempotent replay, outbound webhooks, enumeration accounting.
--
-- Locks: every statement is CREATE on tables that do not yet exist, plus two ADD COLUMN ... NULL
-- on `checks`, which in PostgreSQL 11+ is a catalogue-only change and does not rewrite the table.
-- Safe on a live database.
--
-- As in the initial schema: no raw-IMEI column anywhere, and there never will be (ADR-0003).

-- migrate:up

-- What we need to answer GET /v1/checks/:id without re-deriving it, and to bill honestly.
ALTER TABLE checks ADD COLUMN IF NOT EXISTS imei_masked      text;
ALTER TABLE checks ADD COLUMN IF NOT EXISTS subject_hash     text;  -- HMAC(tenant_salt, digits)
ALTER TABLE checks ADD COLUMN IF NOT EXISTS credits_charged  bigint NOT NULL DEFAULT 0;
ALTER TABLE checks ADD COLUMN IF NOT EXISTS verdict          text;

-- A retried POST /v1/checks must return the FIRST response, not run a second paid check.
-- The stored body is the whole point: replaying the request would charge twice, and returning a
-- fresh 200 with different content breaks the promise the header makes.
CREATE TABLE idempotency_records (
  tenant_id      text NOT NULL REFERENCES tenants(id),
  key            text NOT NULL,
  -- Binds the key to the request it was used for. A client reusing one key for a different IMEI
  -- is a bug on their side; silently serving the wrong device's report would be one on ours.
  request_digest text NOT NULL,
  check_id       text,
  status_code    int,
  response_body  jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  PRIMARY KEY (tenant_id, key)
);
CREATE INDEX idx_idempotency_created ON idempotency_records (created_at);

-- Standard (non-express) supplier orders: placed, then answered hours later by poll or webhook.
CREATE TABLE provider_orders (
  id                text PRIMARY KEY,
  check_id          text NOT NULL,
  tenant_id         text NOT NULL REFERENCES tenants(id),
  provider_id       text NOT NULL,
  service_id        text NOT NULL,
  capability        text NOT NULL,
  -- Our reference, echoed to the supplier. A webhook is matched on THIS, never on trust.
  reference_id      text NOT NULL UNIQUE,
  -- Their reference, for polling.
  order_reference   text,
  status            text NOT NULL,          -- pending | answered | rejected | abandoned
  attempts          int  NOT NULL DEFAULT 0,
  next_poll_at      timestamptz,
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  settled_at        timestamptz
);
CREATE INDEX idx_provider_orders_pending ON provider_orders (next_poll_at)
  WHERE status = 'pending';
CREATE INDEX idx_provider_orders_check ON provider_orders (check_id);

CREATE TABLE webhook_endpoints (
  id           text PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants(id),
  url          text NOT NULL,
  secret       text NOT NULL,               -- HMAC key; we sign so the tenant can verify us
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
  status        text NOT NULL,              -- pending | delivered | failed
  attempts      int NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  last_status   int,
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz
);
CREATE INDEX idx_webhook_deliveries_pending ON webhook_deliveries (next_retry_at)
  WHERE status = 'pending';

-- Enumeration detection WITHOUT storing IMEIs.
--
-- The bucket is (tac, first 3 digits of the serial portion): 1000 buckets per TAC. A sweep lights
-- up as "touched 900 of 1000 buckets under one TAC within an hour", which cannot happen honestly.
-- A TAC is a model, not a person, and three digits of serial identifies nobody — so this detects
-- the attack without retaining the thing we promised not to retain.
CREATE TABLE enumeration_buckets (
  tenant_id   text NOT NULL REFERENCES tenants(id),
  tac         text NOT NULL,
  bucket      smallint NOT NULL,            -- 0..999
  window_start timestamptz NOT NULL,
  hits        int NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, tac, bucket, window_start)
);
CREATE INDEX idx_enumeration_window ON enumeration_buckets (tenant_id, window_start);

-- The abuse ladder's current position per tenant: log -> throttle -> cache_only -> no_paid -> suspended.
-- `cache_only` is the important rung: it costs us nothing, still answers, and so a false positive
-- does not cost the tenant their service or us the revenue.
CREATE TABLE tenant_restrictions (
  tenant_id   text PRIMARY KEY REFERENCES tenants(id),
  level       text NOT NULL DEFAULT 'none',
  reason      text,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz
);

-- migrate:down

DROP TABLE IF EXISTS tenant_restrictions, enumeration_buckets;
DROP TABLE IF EXISTS webhook_deliveries, webhook_endpoints;
DROP TABLE IF EXISTS provider_orders, idempotency_records;
ALTER TABLE checks DROP COLUMN IF EXISTS verdict;
ALTER TABLE checks DROP COLUMN IF EXISTS credits_charged;
ALTER TABLE checks DROP COLUMN IF EXISTS subject_hash;
ALTER TABLE checks DROP COLUMN IF EXISTS imei_masked;
