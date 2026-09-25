-- Deep checks and encrypted IMEI (ADR-0007).
--
-- Locks: ADD COLUMN with a constant DEFAULT or NULL is catalogue-only on PostgreSQL 11+; the new
-- table and trigger touch nothing existing; the partial index is built CONCURRENTLY below the
-- transaction marker. Safe on a live database.

-- migrate:up

-- Existing rows were paid checks, so 'deep' is the truthful backfill.
ALTER TABLE checks ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'deep'
  CHECK (tier IN ('free', 'deep'));
-- AES-256-GCM: nonce(12) || ciphertext || tag(16), AAD = check id. NULL on pre-ADR-0007 rows.
ALTER TABLE checks ADD COLUMN IF NOT EXISTS imei_encrypted   bytea;
ALTER TABLE checks ADD COLUMN IF NOT EXISTS imei_key_version int;

-- HMAC(SERVER_PEPPER, digits), for attaching a second check to an order already running.
ALTER TABLE provider_orders ADD COLUMN IF NOT EXISTS imei_hash text;

CREATE TABLE imei_reveals (
  id          text PRIMARY KEY,
  check_id    text NOT NULL,
  actor       text NOT NULL,           -- 'api:<key id>' | 'cli'
  reason      text NOT NULL,
  revealed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_imei_reveals_check ON imei_reveals (check_id);

CREATE FUNCTION imei_reveals_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'imei_reveals is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER imei_reveals_no_mutation BEFORE UPDATE OR DELETE ON imei_reveals
  FOR EACH ROW EXECUTE FUNCTION imei_reveals_is_append_only();

-- migrate:down

DROP TRIGGER IF EXISTS imei_reveals_no_mutation ON imei_reveals;
DROP FUNCTION IF EXISTS imei_reveals_is_append_only();
DROP TABLE IF EXISTS imei_reveals;
ALTER TABLE provider_orders DROP COLUMN IF EXISTS imei_hash;
ALTER TABLE checks DROP COLUMN IF EXISTS imei_key_version;
ALTER TABLE checks DROP COLUMN IF EXISTS imei_encrypted;
ALTER TABLE checks DROP COLUMN IF EXISTS tier;
