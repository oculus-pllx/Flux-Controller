# HA Maintenance Recovery Implementation Plan

> Implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Restore only Flux-owned Proxmox HA maintenance after fresh online power and agent recovery, in public Flux-Controller and private Flux.

**Architecture:** Agents journal ownership before shutdown. The controller persists independent per-node recovery records and per-cluster policy snapshots, and reconciles them on authenticated reconnect and fresh UPS polling until verified acknowledgements arrive. Recovery remains separate from cancellation of the shutdown schedule.

**Tech Stack:** Node.js CommonJS, Sequelize/SQLite, WebSocket, Jest, Proxmox local CLI.

## 1. Agent ownership and verified clear

Files: create `flux-agent/services/ha-maintenance.js` and
`flux-agent/__tests__/ha-maintenance.test.js`; extend `services/proxmox.js`,
`services/sequencer.js`, `services/ws-client.js`, `agent.js` and their tests.

- [x] Write failing tests using temporary state files and fake Proxmox commands.
  Cover pre-existing manual maintenance, durable owned state, interrupted enable,
  matching verified clear, mismatched event, no quorum, duplicate command after a
  later manual enable, and failed verification.
- [x] Run `cd flux-agent && npm test -- --runTestsByPath __tests__/ha-maintenance.test.js`;
  confirm expected failures before implementing the ownership helper.
- [x] Use atomic mode0600 state writes; separate intent, owned, and cleared states.
  Read local HA state/quorum with fixed executable/argument arrays; bounded waits
  verify flags rather than assuming a queued command completed.
- [x] Add ownership to shutdown-step and registration messages. Clear only through
  the ownership helper, acknowledge request/event/node IDs, and advertise recovery
  capability. Preserve external maintenance and legacy unknown ownership.
- [x] Run focused agent tests, then the complete agent suite. Bump agent minor
  version for the new protocol; keep package lock metadata consistent.

## 2. Durable controller recovery and online-power gate

Files: create `backend/models/HaRecovery.js`, `services/haRecoveryService.js`, and
`backend/__tests__/haRecovery.test.js`; modify `models/PowerEvent.js`,
`services/agentHub.js`, `services/pollingService.js` and relevant existing tests.

- [x] Write failing tests for offline-at-restoration then reconnect, restart with
  pending work, failed/lost/forged acknowledgements, stale UPS data, manual or
  ambiguous ownership, lost quorum, duplicate messages, and a second outage.
- [x] Run `cd backend && npm test -- --runTestsByPath __tests__/haRecovery.test.js`.
- [x] Persist one recovery row per event/node and exact shutdown scope. Separate
  cluster-policy snapshots from node ownership. Restore the original policy only
  to its recorded cluster, after all overlapping outages there have resolved.
- [x] Gate cancellation/recovery on fresh positive OL without OB/LB/FSD. Reconcile
  pending rows through the existing poller and authenticated registration/status
  paths, with serialized work and bounded retry pacing. Save requests before send;
  complete only for matching authenticated verified acknowledgements.
- [x] Update the existing connected-agent recovery test to model real fresh UPS
  state and explicit ownership; retain shutdown/role/API compatibility tests.
- [x] Run complete backend tests and focused coverage gates. Verify additive schema
  initialization against a database created without the new fields/model.

## 3. Verify, synchronize and publish

- [x] Inspect installed agent packaging and update inclusion/version tests where
  necessary. Run frontend production build to catch shared packaging regressions.
- [x] Self-review failure/ownership/race paths using requesting-code-review.
- [x] Append `DECISIONS.md`, document upgrade order and unknown legacy flags, and
  record exact test results. Keep all live credentials and state out of commits.
- [ ] Commit public source. Copy only reviewed shared code/tests/docs to private
  Flux; preserve its separate PRISM deployment files and private documentation.
- [ ] Verify both suites in the private checkout and compare changed shared files
  byte-for-byte. Commit private source with public revision traceability.
- [ ] Push both main branches without force. Do not create or publish a release or
  deploy to PRISM merely because the repository fix is complete. Record any
  automatically started CI once; leave it unattended.
- [x] Report pushed revisions and any remaining live rollout limitation. Existing
  PVE3/PVE5 flags require ownership evidence or explicit remediation authorization;
  this repository fix does not blindly clear them.
