\restrict dbmate

-- Dumped from database version 17.11
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: imei_reveals_is_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.imei_reveals_is_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'imei_reveals is append-only';
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id text NOT NULL,
    tenant_id text NOT NULL,
    prefix text NOT NULL,
    key_sha256 text NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    label text,
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone
);


--
-- Name: cache_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cache_entries (
    cache_key text NOT NULL,
    capability text NOT NULL,
    field text NOT NULL,
    payload jsonb NOT NULL,
    coverage jsonb NOT NULL,
    checked_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    provider_id text
);


--
-- Name: check_sections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.check_sections (
    check_id text NOT NULL,
    capability text NOT NULL,
    outcome text NOT NULL,
    reason text,
    remedy text,
    finding_key text,
    severity text,
    evidence jsonb DEFAULT '[]'::jsonb NOT NULL,
    coverage jsonb NOT NULL,
    checked_at timestamp with time zone NOT NULL,
    cached boolean DEFAULT false NOT NULL
);


--
-- Name: checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.checks (
    id text NOT NULL,
    tenant_id text NOT NULL,
    imei_hash text NOT NULL,
    imei_hash_version integer DEFAULT 1 NOT NULL,
    tac text,
    requested_capabilities text[] NOT NULL,
    status text NOT NULL,
    idempotency_key text,
    max_credits integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    imei_masked text,
    subject_hash text,
    credits_charged bigint DEFAULT 0 NOT NULL,
    verdict text,
    tier text DEFAULT 'deep'::text NOT NULL,
    imei_encrypted bytea,
    imei_key_version integer,
    CONSTRAINT checks_tier_check CHECK ((tier = ANY (ARRAY['free'::text, 'deep'::text])))
)
PARTITION BY RANGE (created_at);


--
-- Name: checks_default; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.checks_default (
    id text NOT NULL,
    tenant_id text NOT NULL,
    imei_hash text NOT NULL,
    imei_hash_version integer DEFAULT 1 NOT NULL,
    tac text,
    requested_capabilities text[] NOT NULL,
    status text NOT NULL,
    idempotency_key text,
    max_credits integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    imei_masked text,
    subject_hash text,
    credits_charged bigint DEFAULT 0 NOT NULL,
    verdict text,
    tier text DEFAULT 'deep'::text NOT NULL,
    imei_encrypted bytea,
    imei_key_version integer,
    CONSTRAINT checks_tier_check CHECK ((tier = ANY (ARRAY['free'::text, 'deep'::text])))
);


--
-- Name: idempotency_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idempotency_records (
    tenant_id text NOT NULL,
    key text NOT NULL,
    request_digest text NOT NULL,
    check_id text,
    status_code integer,
    response_body jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: imei_reveals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.imei_reveals (
    id text NOT NULL,
    check_id text NOT NULL,
    actor text NOT NULL,
    reason text NOT NULL,
    revealed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_calls (
    id text NOT NULL,
    check_id text,
    tenant_id text NOT NULL,
    provider_id text NOT NULL,
    service_id text NOT NULL,
    capability text NOT NULL,
    status text NOT NULL,
    http_status integer,
    latency_ms integer,
    provider_cost_usd numeric(10,4),
    credits_charged integer DEFAULT 0 NOT NULL,
    billable boolean DEFAULT true NOT NULL,
    response_digest text,
    error_code text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone
)
PARTITION BY RANGE (started_at);


--
-- Name: provider_calls_default; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_calls_default (
    id text NOT NULL,
    check_id text,
    tenant_id text NOT NULL,
    provider_id text NOT NULL,
    service_id text NOT NULL,
    capability text NOT NULL,
    status text NOT NULL,
    http_status integer,
    latency_ms integer,
    provider_cost_usd numeric(10,4),
    credits_charged integer DEFAULT 0 NOT NULL,
    billable boolean DEFAULT true NOT NULL,
    response_digest text,
    error_code text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone
);


--
-- Name: provider_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_orders (
    id text NOT NULL,
    check_id text NOT NULL,
    tenant_id text NOT NULL,
    provider_id text NOT NULL,
    service_id text NOT NULL,
    capability text NOT NULL,
    reference_id text NOT NULL,
    order_reference text,
    status text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_poll_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    imei_hash text
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: tac_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tac_entries (
    tac text NOT NULL,
    manufacturer text NOT NULL,
    model text NOT NULL,
    marketing_name text,
    source text NOT NULL,
    source_priority integer NOT NULL,
    source_version text NOT NULL,
    first_seen timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tac_imports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tac_imports (
    id bigint NOT NULL,
    source text NOT NULL,
    source_url text,
    license text,
    checksum text,
    row_count integer,
    status text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone
);


--
-- Name: tac_imports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tac_imports_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tac_imports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tac_imports_id_seq OWNED BY public.tac_imports.id;


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id text NOT NULL,
    name text NOT NULL,
    plan text DEFAULT 'free'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    imei_salt text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: checks_default; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checks ATTACH PARTITION public.checks_default DEFAULT;


--
-- Name: provider_calls_default; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_calls ATTACH PARTITION public.provider_calls_default DEFAULT;


--
-- Name: tac_imports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tac_imports ALTER COLUMN id SET DEFAULT nextval('public.tac_imports_id_seq'::regclass);


--
-- Name: api_keys api_keys_key_sha256_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_sha256_key UNIQUE (key_sha256);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: cache_entries cache_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cache_entries
    ADD CONSTRAINT cache_entries_pkey PRIMARY KEY (cache_key);


--
-- Name: check_sections check_sections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.check_sections
    ADD CONSTRAINT check_sections_pkey PRIMARY KEY (check_id, capability);


--
-- Name: checks checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checks
    ADD CONSTRAINT checks_pkey PRIMARY KEY (id, created_at);


--
-- Name: checks_default checks_default_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checks_default
    ADD CONSTRAINT checks_default_pkey PRIMARY KEY (id, created_at);


--
-- Name: idempotency_records idempotency_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_records
    ADD CONSTRAINT idempotency_records_pkey PRIMARY KEY (tenant_id, key);


--
-- Name: imei_reveals imei_reveals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imei_reveals
    ADD CONSTRAINT imei_reveals_pkey PRIMARY KEY (id);


--
-- Name: provider_calls provider_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_calls
    ADD CONSTRAINT provider_calls_pkey PRIMARY KEY (id, started_at);


--
-- Name: provider_calls_default provider_calls_default_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_calls_default
    ADD CONSTRAINT provider_calls_default_pkey PRIMARY KEY (id, started_at);


--
-- Name: provider_orders provider_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_orders
    ADD CONSTRAINT provider_orders_pkey PRIMARY KEY (id);


--
-- Name: provider_orders provider_orders_reference_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_orders
    ADD CONSTRAINT provider_orders_reference_id_key UNIQUE (reference_id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: tac_entries tac_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tac_entries
    ADD CONSTRAINT tac_entries_pkey PRIMARY KEY (tac);


--
-- Name: tac_imports tac_imports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tac_imports
    ADD CONSTRAINT tac_imports_pkey PRIMARY KEY (id);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: idx_checks_imei_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_checks_imei_hash ON ONLY public.checks USING btree (imei_hash, created_at DESC);


--
-- Name: checks_default_imei_hash_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX checks_default_imei_hash_created_at_idx ON public.checks_default USING btree (imei_hash, created_at DESC);


--
-- Name: idx_checks_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_checks_idempotency ON ONLY public.checks USING btree (tenant_id, idempotency_key, created_at) WHERE (idempotency_key IS NOT NULL);


--
-- Name: checks_default_tenant_id_idempotency_key_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX checks_default_tenant_id_idempotency_key_created_at_idx ON public.checks_default USING btree (tenant_id, idempotency_key, created_at) WHERE (idempotency_key IS NOT NULL);


--
-- Name: idx_api_keys_prefix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_prefix ON public.api_keys USING btree (prefix) WHERE (revoked_at IS NULL);


--
-- Name: idx_cache_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cache_expiry ON public.cache_entries USING btree (expires_at);


--
-- Name: idx_idempotency_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_idempotency_created ON public.idempotency_records USING btree (created_at);


--
-- Name: idx_imei_reveals_check; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_imei_reveals_check ON public.imei_reveals USING btree (check_id);


--
-- Name: idx_provider_calls_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provider_calls_tenant ON ONLY public.provider_calls USING btree (tenant_id, started_at DESC);


--
-- Name: idx_provider_orders_check; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provider_orders_check ON public.provider_orders USING btree (check_id);


--
-- Name: idx_provider_orders_open_imei; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provider_orders_open_imei ON public.provider_orders USING btree (imei_hash, service_id) WHERE (status = 'pending'::text);


--
-- Name: idx_provider_orders_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provider_orders_pending ON public.provider_orders USING btree (next_poll_at) WHERE (status = 'pending'::text);


--
-- Name: provider_calls_default_tenant_id_started_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_calls_default_tenant_id_started_at_idx ON public.provider_calls_default USING btree (tenant_id, started_at DESC);


--
-- Name: checks_default_imei_hash_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_checks_imei_hash ATTACH PARTITION public.checks_default_imei_hash_created_at_idx;


--
-- Name: checks_default_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.checks_pkey ATTACH PARTITION public.checks_default_pkey;


--
-- Name: checks_default_tenant_id_idempotency_key_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_checks_idempotency ATTACH PARTITION public.checks_default_tenant_id_idempotency_key_created_at_idx;


--
-- Name: provider_calls_default_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.provider_calls_pkey ATTACH PARTITION public.provider_calls_default_pkey;


--
-- Name: provider_calls_default_tenant_id_started_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_provider_calls_tenant ATTACH PARTITION public.provider_calls_default_tenant_id_started_at_idx;


--
-- Name: imei_reveals imei_reveals_no_mutation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER imei_reveals_no_mutation BEFORE DELETE OR UPDATE ON public.imei_reveals FOR EACH ROW EXECUTE FUNCTION public.imei_reveals_is_append_only();


--
-- Name: api_keys api_keys_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: idempotency_records idempotency_records_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_records
    ADD CONSTRAINT idempotency_records_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: provider_orders provider_orders_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_orders
    ADD CONSTRAINT provider_orders_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- PostgreSQL database dump complete
--

\unrestrict dbmate


--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('20260912000001'),
    ('20260913000001'),
    ('20260916000001'),
    ('20260925000001'),
    ('20260925000002');
