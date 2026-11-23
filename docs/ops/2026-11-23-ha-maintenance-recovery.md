# Power restoration and Proxmox maintenance recovery

Flux now retains acknowledged HA recovery separately from cancellation of a UPS
shutdown. An agent that was offline at the restoration transition reconciles its
pending recovery when it registers or sends later heartbeats. Successful online
UPS polls also retry recovery after controller restarts.

This fix is shared by public `oculus-pllx/Flux-Controller` and private
`oculus-pllx/Flux`. Their deployment configuration is separate. The SMS controller
is `10.11.200.135:5174`; PRISM's Parallax Lab controller is `192.168.0.55:5174`.
Publishing the source fix does not update either running controller or its agents.

## Ownership and safety

The new agent protocol is `ha-maintenance-recovery-v1`, advertised by agent1.1.0.
Before a scheduled shutdown, the agent inspects the local Proxmox HA state. It
records a local ownership journal only for the relevant node and shutdown event:

- `intent`: Flux is about to request maintenance; interrupted enable is ambiguous.
- `owned`: maintenance was enabled and observed for that event.
- `external`: maintenance was already present; Flux does not claim it.
- `clearing`: a clear was requested; the result has not yet been verified.
- `cleared`: the matching cleanup was observed complete. This durable tombstone
  prevents replay from clearing a later manually enabled flag.

The journal is `/etc/flux-agent/ha-maintenance.json`, atomically written with mode
0600. It contains event/node correlation, not Proxmox tokens or agent bearer keys.
Missing, corrupt, external, or ambiguous ownership never authorizes a clear. A
`clearing` record can acknowledge an already cleared node; if maintenance is still
set, it requires review rather than blindly issuing a second clear.

The controller retains `HaRecoveries` rows and exact `PowerEvents.shutdownMachineKeys`.
It correlates the registered socket, event, node, device, and request ID before
accepting a result. Failed/lost acknowledgements stay pending and attempts are paced
at least30seconds apart. Do not infer completion from the shutdown event becoming
`cancelled` or a clear command merely being queued.

Recovery requires all of the following:

1. A fresh successful UPS sample with an `OL` token and no `OB`, `LB`, or `FSD`.
2. An active registered agent with the new recovery capability and matching local
   ownership. Null registration metadata cannot erase its configured cluster scope.
3. Cluster quorum, checked both centrally and locally before a node clear.
4. No active outage involving that node or another UPS in its cluster.
5. Successful restoration of any recorded cluster policy and a verified node clear.

Cluster-policy snapshots are keyed by actual cluster ID. Overlapping outages retain
the original pre-Flux policy. An absent original HA setting is restored by deleting
the override. Recovery does not overwrite a different policy an operator set after
Flux's freeze; that discrepancy requires review.

## Upgrade order

Upgrade the controller first, then its Proxmox agents to1.1.0. A new agent refuses
old uncorrelated clear commands; a new controller does not blindly clear maintenance
on old agents without ownership support.

Before live upgrades, identify the correct controller and save its exact release,
agent files, configuration, and a consistent SQLite backup. For SMS, the documented
native installation uses `/var/lib/flux/flux.db`; confirm the live service's effective
DB path before using it. Use SQLite's backup API and verify the copy with
`PRAGMA quick_check`, rather than copying a database while it is live. Preserve
all runtime credentials and enrollment keys in their existing protected locations.

Schema initialization is additive: it adds `HaRecoveries`, `shutdownMachineKeys`,
and `haPolicySnapshots`, retaining existing events, ownership lists and unrelated
columns. Back up before upgrading. The tests include a pre-upgrade database fixture.

The Linux package builders recursively include agent services, so the new ownership
helper is included in the normal agent payload. Rebuild the installer/agent bundle
from the committed release; copying only `agent.js` is insufficient. Publishing
GitHub main does not publish an installer release or upgrade existing agents.

## Read-only diagnostics

On the intended PVE host:

```sh
systemctl is-active flux-agent
ha-manager status
pvecm status
```

Inspect the ownership journal locally with authorized access and correlate the
shutdown ID with the controller's recovery record. Agent bearer keys and Proxmox
tokens belong only in protected configuration; do not print the full agent config
or unrestricted `AgentMachines` rows.

On a protected controller database connection, this query omits machine bearer keys:

```sql
SELECT m.hostname, r.node, r.shutdownId, r.state, r.requestedAt, r.completedAt,
       r.lastError
FROM HaRecoveries AS r
JOIN AgentMachines AS m ON m.machineKey = r.machineKey
ORDER BY r.id DESC;
```

Normal transient recovery failures remain pending for retry. Agent state detail
reports pending policy/maintenance recovery or ambiguous ownership requiring review.
Do not delete a journal or manufacture an `owned` state to force cleanup.

## Legacy outage flags

An older outage has no new ownership journal or exact shutdown scope. Its old
`haPreparedMachineKeys` list also included helpers used to change cluster policy;
it cannot prove node-maintenance ownership. Existing legacy flags require evidence
or an explicit administrative decision before remediation. In particular, this
source fix alone does not clear the observed SMS PVE3/PVE5 flags.

No guest reboot, migration, maintenance clear or controller deployment is required
for repository verification. Regression tests use disposable state/databases,
WebSockets and simulated Proxmox operations rather than issuing live power commands.

## Deployment status — 2026-11-23

An owner-authorized rollout subsequently installed the controller fix, upgraded
five Proxmox agents to 1.1.0, and refreshed the installer bundle. Health, agent
registration, database integrity, quorum, maintenance clearance and unchanged
guest placement were verified. Production-specific receipts and rollback details
are retained in private operations records. A real outage drill remains untested.
