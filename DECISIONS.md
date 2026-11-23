# Architecture decisions

## 2026-11-23 — Proposed durable power-restoration cleanup

Investigation identified one-shot recovery delivery in agentHub: offline agents
are skipped before the power event is cancelled; reconnect does not reconcile
cleanup and maintenance-clear acknowledgements are ignored. The proposed repair
uses durable per-event/node ownership and acknowledged retry, gated by fresh
online UPS data and cluster readiness. Preserve manually enabled maintenance and
separate cluster-policy restoration from node-maintenance ownership. SMS controller
`.135` and PRISM are separate deployment targets. This proposal awaits owner design
review; it records no production change or assertion that Flux caused the current
PVE3/PVE5 flags. See docs/specs/2026-11-23-ha-maintenance-recovery-design.md.

## 2026-11-23 — Approved acknowledged HA recovery in public and private source

Owner approved implementation and requested alignment of private `oculus-pllx/Flux`
and public `oculus-pllx/Flux-Controller`. Separate durable recovery rows from power
shutdown cancellation, record actual shutdown scope, and keep policy snapshots per
cluster. Reconcile on authenticated agent registration/heartbeats and fresh positive
OL polling, with quorum and overlapping-outage checks. Agents1.1.0 persist verified
ownership and intent/clearing phases plus a cleared tombstone. Preserve manual
maintenance and manual policy changes. Retain and expose ambiguous work for review;
do not retroactively claim ownership of legacy flags. Repository publication does
not authorize a PRISM deployment or manufacture an installer release. See
`docs/ops/2026-11-23-ha-maintenance-recovery.md` for upgrade order and diagnostics.
