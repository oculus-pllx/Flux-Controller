# Verified UPS maintenance recovery source fix — 2026-11-23

Repository: `oculus-pllx/Flux-Controller` (public).

## Checks and results

- Full backend suite: 244 tests across29suites passed.
- Full agent suite:83tests across13suites passed; protocol/package version1.1.0.
- New controller recovery/model coverage:95.83% statements,86.55% branches,
  92.59% functions,98.91% lines.
- New agent ownership helper coverage:91.83% statements,81.15% branches,
  84.61% functions,96.05% lines.
- Public frontend production build passed; existing Vite chunk-size advisory only.
- All25changed shared application/test files match between the two repositories.
- Existing private monitoring/deployment files retained. Its prior NUT polling-error
  recovery and regression test were preserved and carried into public source.
- `git diff --check` passed. No credential, runtime state, HANDOFF, or generated
  dependency/build directory is part of the change.

## Reviewed behavior

Tests first reproduced offline-at-restoration loss, missing acknowledgement handling,
unsafe UPS status handling, lost cluster scope on null registration, and ownership
and policy failure cases. Temporary agent state and SQLite fixtures plus real local
WebSockets exercise reconnect and authenticated acknowledgement paths. An additive
schema-upgrade fixture preserves old events, JSON fields, and unrelated columns.

Self-review covered manual maintenance already present, durable intent/clearing
ambiguity, duplicate clear after later manual maintenance, failed/lost/forged replies,
restart and heartbeat replay, stale UPS data, local/central quorum checks, another
outage in the same cluster, fixed/bounded local CLI arguments, missing original HA
options, original policy across overlapping outages, and later operator policy
changes. Ownership verification errors preserve graceful guest draining instead of
skipping directly to host power-off.

All maintenance, policy, guest and power commands in tests use simulated drivers;
no live Proxmox mutation, controller deployment, release tag, or installer publication
was required. Existing legacy PVE3/PVE5 flags remain subject to ownership review.

Private receipts/logs are under `/tmp/flux-ha-recovery-20261123/` on the workstation.
See `docs/ops/2026-11-23-ha-maintenance-recovery.md` for rollout order and diagnostics.
