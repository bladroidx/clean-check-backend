# Alerts

The signals that protect money and privacy are only worth something if someone is paged on them.
Nothing in this repo routes alerts; these are the rules to load into whatever scrapes the API's
`/metrics` (port 3000) and the worker's `/metrics` (port 9464, compose network only). Error-level
log lines carry the same events for a log-based alerting setup.

```yaml
groups:
  - name: imei-check
    rules:
      # A silent supplier reprice, or spend our books did not record. The worker has already
      # started a price check; a disabled service will show below.
      - alert: SupplierBalanceDrift
        expr: increase(imei_provider_balance_drift_total[2h]) > 0
        labels: { severity: page }
        annotations:
          summary: "{{ $labels.provider_id }} balance fell faster than recorded spend"

      # The drift job switched services off. Deep checks for them are unavailable until someone
      # reprices packages/providers/catalogue/*.yaml, deploys, and runs
      # `npm run service:override -- clear <provider> <service>`.
      - alert: CatalogueServicesDisabled
        expr: imei_services_disabled > 0
        for: 5m
        labels: { severity: page }

      - alert: SupplierBalanceLow
        expr: imei_provider_balance_runway_days < 3
        labels: { severity: ticket }

      # A job that silently stopped is the failure no counter shows. Thresholds are 2x each
      # job's default interval, plus slack.
      - alert: WorkerJobStale
        expr: |
          (time() - imei_job_last_success_timestamp_seconds{job="poll-orders"}       > 600)
          or (time() - imei_job_last_success_timestamp_seconds{job="reconcile-balance"} > 3 * 3600)
          or (time() - imei_job_last_success_timestamp_seconds{job="catalogue-drift"}   > 2 * 86400 + 3600)
          or (time() - imei_job_last_success_timestamp_seconds{job="retention"}         > 2 * 86400 + 3600)
        labels: { severity: page }
        annotations:
          summary: "worker job {{ $labels.job }} has not succeeded recently"

      - alert: WorkerJobMissing
        expr: absent(imei_job_last_success_timestamp_seconds{job="retention"})
        for: 1h
        labels: { severity: ticket }

      # The format-drift alarm (see metrics.ts): a supplier reworded a value we rely on.
      - alert: LexiconMiss
        expr: increase(imei_lexicon_miss_total[1h]) > 0
        labels: { severity: ticket }

      - alert: ProviderCircuitOpen
        expr: imei_provider_circuit_open == 1
        for: 5m
        labels: { severity: page }
```

Retention failing (`WorkerJobStale{job="retention"}`) is a privacy issue, not only an operational
one: data past the published window is being kept. The usual cause is a backup holding a lock at
the same time as the daily run (DETACH gives up after 5 s); move one of them.
