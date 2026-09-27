-- Retention: real monthly partitions for `checks` and `provider_calls`.
--
-- Both tables were declared PARTITION BY RANGE so that retention would be a partition drop, but
-- only ever had a DEFAULT partition -- so nothing was ever dropped, and `checks.imei_encrypted`
-- (the reversible IMEI, ADR-0007) accumulated forever. This migration creates monthly partitions
-- covering every existing row plus two months ahead; the worker's retention job
-- (`runRetention` in packages/core/src/db/retention.ts, a daily worker loop) keeps creating them ahead and drops the expired ones.
--
-- `imei_ensure_month_partition` is the one way a monthly partition is created, here and by the
-- worker. If rows for that month already sit in the DEFAULT partition (the worker was down long
-- enough for the months-ahead margin to run out) it moves them into the new partition first --
-- Postgres refuses to attach a range that overlaps rows already in DEFAULT.
--
-- Locks: ATTACH PARTITION takes SHARE UPDATE EXCLUSIVE on the parent and ACCESS EXCLUSIVE on the
-- DEFAULT partition while it verifies no row in DEFAULT falls in the new range. The DEFAULT
-- partition is small (staging) or empty (production) at the time this runs, so the lock is held
-- for milliseconds; the moved rows are copied, not rewritten in place. Month bounds are UTC.

-- migrate:up

CREATE FUNCTION imei_ensure_month_partition(parent regclass, key_column text, month_start date)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  parent_name  text := (SELECT relname FROM pg_class WHERE oid = parent);
  child_name   text := parent_name || '_p' || to_char(month_start, 'YYYYMM');
  default_name text := parent_name || '_default';
  first_day    date := date_trunc('month', month_start)::date;
  next_first   date := (date_trunc('month', month_start) + interval '1 month')::date;
  lo           timestamptz;
  hi           timestamptz;
  cols         text;
BEGIN
  -- Never queue behind a long reader (a pg_dump backup) holding up every API query behind us:
  -- give up after 5 s and let the next run retry.
  PERFORM set_config('lock_timeout', '5s', true);
  -- Two workers may run this at once; serialise per parent for the rest of the transaction.
  PERFORM pg_advisory_xact_lock(hashtext('imei_partition:' || parent_name));
  IF to_regclass(child_name) IS NOT NULL THEN
    RETURN NULL;
  END IF;

  -- From dates, not `lo + interval '1 month'`: timestamptz month arithmetic runs in the session
  -- time zone and drifts by an hour across DST.
  lo := make_timestamptz(extract(year FROM first_day)::int, extract(month FROM first_day)::int, 1, 0, 0, 0, 'UTC');
  hi := make_timestamptz(extract(year FROM next_first)::int, extract(month FROM next_first)::int, 1, 0, 0, 0, 'UTC');

  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO cols
    FROM pg_attribute WHERE attrelid = parent AND attnum > 0 AND NOT attisdropped;

  EXECUTE format('CREATE TABLE %I (LIKE %s INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', child_name, parent);
  IF to_regclass(default_name) IS NOT NULL THEN
    -- Lock DEFAULT before reading it: under READ COMMITTED a row the API commits into DEFAULT
    -- between a copy and a separate delete would be deleted without ever being copied. ATTACH
    -- takes this lock anyway; taking it first closes that gap. The move is one statement too.
    EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', default_name);
    EXECUTE format('WITH moved AS (DELETE FROM %I WHERE %I >= $1 AND %I < $2 RETURNING %s) '
                   'INSERT INTO %I (%s) SELECT %s FROM moved',
                   default_name, key_column, key_column, cols, child_name, cols, cols) USING lo, hi;
  END IF;
  EXECUTE format('ALTER TABLE %s ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)',
                 parent, child_name, lo, hi);
  RETURN child_name;
END;
$$;

DO $$
DECLARE
  this_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  last_month date := (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '2 months')::date;
  m date;
BEGIN
  m := LEAST(this_month, COALESCE(
    (SELECT date_trunc('month', min(created_at) AT TIME ZONE 'UTC')::date FROM checks), this_month));
  WHILE m <= last_month LOOP
    PERFORM imei_ensure_month_partition('checks'::regclass, 'created_at', m);
    m := (m + interval '1 month')::date;
  END LOOP;

  m := LEAST(this_month, COALESCE(
    (SELECT date_trunc('month', min(started_at) AT TIME ZONE 'UTC')::date FROM provider_calls), this_month));
  WHILE m <= last_month LOOP
    PERFORM imei_ensure_month_partition('provider_calls'::regclass, 'started_at', m);
    m := (m + interval '1 month')::date;
  END LOOP;
END;
$$;

-- migrate:down

-- Fold every monthly partition back into DEFAULT, then drop the function.
DO $$
DECLARE
  part record;
BEGIN
  FOR part IN
    SELECT p.relname AS parent, c.relname AS child
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname IN ('checks', 'provider_calls')
       AND c.relname ~ '_p[0-9]{6}$'
  LOOP
    EXECUTE format('ALTER TABLE %I DETACH PARTITION %I', part.parent, part.child);
    EXECUTE format('INSERT INTO %I SELECT * FROM %I', part.parent, part.child);
    EXECUTE format('DROP TABLE %I', part.child);
  END LOOP;
END;
$$;
DROP FUNCTION IF EXISTS imei_ensure_month_partition(regclass, text, date);
