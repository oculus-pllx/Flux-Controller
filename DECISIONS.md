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
