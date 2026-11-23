# Recover Flux-owned Proxmox maintenance after power restoration

## Problem and verified evidence

The SMS five-node Proxmox cluster returned after the 2026-11-23 power outage.
All nodes are online, quorum is 5/5, and PVE3/PVE5 storage and ZFS checks passed.
Their HA manager has explicit maintenance requests set. Their original requester
has not yet been established from retained logs; do not assume ownership from the
presence of a maintenance flag alone.

The live PVE3 Flux agent connects to `http://10.11.200.135:5174`, whose health
endpoint returns HTTP 200. The agent's `agent.js` and `services/sequencer.js`
SHA-256 hashes exactly match the inspected local Flux source. It attempted to
reconnect before the SMS controller was reachable during boot.

In `backend/services/agentHub.js`, `notifyPowerRestored` skips disconnected agents
and then marks the power event cancelled. `handleRegister` does not replay cleanup.
The agent sends `ha-maintenance-disabled` and `ha-maintenance-disable-error`, but
the controller has no handlers for these acknowledgements. A clear command can
therefore be lost or fail while the event appears resolved. Existing tests cover
only agents already connected when restoration is announced.

Additional ownership issues in the current path must be addressed: successful
cluster-policy freeze adds a machine to `haPreparedMachineKeys`, and the agent
reports maintenance enabled without recording whether it was previously enabled
manually. Neither is sufficient proof that Flux owns a node's maintenance flag.

## Recommended approach and alternatives

Use durable, acknowledged recovery per shutdown event and node. Replay pending
cleanup on authenticated agent registration and through the existing successful
UPS polling/agent heartbeat paths. This survives controller and agent restarts
without a new scheduler service.

A startup-only clear would miss later reconnects and cannot distinguish manual
maintenance. Retrying only in memory would lose work on a controller restart.
Neither alternative satisfies the recovery contract.

## Ownership and recovery contract

Before enabling node maintenance, the agent reads the existing HA state. If the
node is already in maintenance, record that it is externally owned and never
clear it automatically. For a Flux transition, persist a credential-free recovery
record containing shutdown ID, UPS/device ID, node, prior state, and transition
phase; use atomic writes and restrictive permissions. Confirm the HA request was
applied before acknowledging ownership. An interrupted or ambiguous transition
must remain visible for review rather than be silently claimed.

Keep cluster shutdown-policy restoration separate from node-maintenance ownership.
A cluster-policy freeze does not grant permission to clear maintenance on the
agent used to execute it. Preserve the captured pre-outage policy and cluster
association until restoration succeeds.

A power event may stop scheduling shutdowns once power returns, but its recovery
work remains pending until each owned action is acknowledged and verified.
Disconnected nodes and failures remain pending across restarts. Agent registration
and later heartbeats should reconcile this work, with one outstanding attempt per
node/event and bounded retry pacing.

Only recover when a fresh successful UPS sample positively reports online power
(`OL`, without `OB` or `LB`), the affected node has returned, the cluster has quorum,
and no active shutdown affecting that node/cluster supersedes the recovery event.
Do not treat absent or malformed UPS status, stale cached data, or mere agent
connectivity as proof of restored power. New outages suspend old recovery attempts.

Bind acknowledgements to the authenticated WebSocket, expected node, and shutdown
ID. A failed command, mismatched acknowledgement, stale event, or disconnected
socket cannot mark cleanup complete. The agent also checks its matching ownership
record before executing a clear. Record success only after observing maintenance
actually cleared; the HA command being queued is not completion.

Existing events without reliable ownership records must be reported as legacy
recovery requiring review. Do not infer ownership from maintenance alone or from
cluster freeze membership. PVE3/PVE5's current flags remain unchanged until their
ownership is established or the owner explicitly authorizes their remediation.

## Implementation boundaries

Application changes belong in the Flux-Controller source repository. The parallel
private Flux checkout has matching inspected recovery logic, but its deployment
history includes a separate PRISM controller for the Parallax Lab. SMS recovery
uses the SMS controller at `.135`; do not deploy to PRISM or change its agents as
part of an SMS repair. Preserve both controllers' UPS credentials and policies.

Likely affected modules are backend `models/PowerEvent.js`,
`services/agentHub.js`, `services/pollingService.js`, and agent `agent.js`,
`services/sequencer.js`, `services/proxmox.js`, plus a focused persistent ownership
helper. Keep model migrations additive and test existing database upgrades.
Document any deliberate synchronization to the private source checkout separately;
do not overwrite its unrelated deployment files.

## Verification and rollout

Write failing tests first for late reconnect after power restoration, controller
restart, lost and failed acknowledgements, manual maintenance already present,
wrong shutdown/node identity, duplicate delivery, lost local state, missing/stale
UPS data, no quorum, and a second outage during recovery. Retain the existing
connected-agent recovery test and shutdown sequencing tests. Verify the original
HA policy is restored only to its recorded cluster.

Use simulated command runners and disposable database/state fixtures; tests must
not issue real shutdown, guest migration, or maintenance commands. Run relevant
backend and agent suites, coverage gates, and structured code review before a
release. Preserve release/agent files and create and verify a consistent SQLite
backup before live updates. Confirm live controller identity, access, versions,
agent ownership support, UPS status, and quorate cluster before activation.

Roll out only to the verified SMS controller and its affected agents. Validate
reconnection and acknowledged recovery without simulating a real power failure.
No Proxmox guests are relocated or rebooted by this fix; node maintenance is
cleared only under the verified ownership and recovery contract above.

## Approval

Owner approved this design on2026-11-23 and explicitly requested the source fix in
both the public and private Parallax repositories. Implementation adds controller
recovery rows and agent1.1.0 ownership journals, including an ambiguous-clear phase.
Live SMS PVE3/PVE5 ownership remains unconfirmed and their flags are not cleared by
repository publication. No PRISM deployment is implied. KAG consolidation and
zman-reference/wiki remain outside this change.
