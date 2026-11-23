const EventEmitter = require('events')
const WebSocket = require('ws')
const AgentMachine = require('../models/AgentMachine')
const AgentMachineEvent = require('../models/AgentMachineEvent')
const PowerEvent = require('../models/PowerEvent')
const Device = require('../models/Device')
const { buildShutdownScope } = require('./clusterService')
const proxmoxService = require('./proxmoxService')
const crypto = require('crypto')
const { createRecoveryService, freshOnline } = require('./haRecoveryService')
const recovery = createRecoveryService({ sendToMachine, proxmox: proxmoxService })

// machineKey → WebSocket
const connections = new Map()
let wss = null

const hub = new EventEmitter()

function attach(httpServer) {
  wss = new WebSocket.Server({ server: httpServer, path: '/api/agent' })
  wss.on('connection', (ws) => {
    let machineKey = null

    ws.on('message', async (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { ws.close(1008, 'invalid json'); return }

      try {
        await handleMessage(ws, msg, (key) => { machineKey = key })
      } catch (err) {
        console.error('[agentHub] message error:', err.message)
      }
    })

    ws.on('close', async () => {
      if (!machineKey || connections.get(machineKey) !== ws) return
      connections.delete(machineKey)
      try {
        const m = await AgentMachine.findOne({ where: { machineKey } })
        if (m) await setState(m, 'offline')
      } catch {}
    })

    ws.on('error', (err) => {
      console.error('[agentHub] ws error:', err.message)
    })
  })
}

function detach() {
  if (wss) { wss.close(); wss = null }
  connections.clear()
}

async function handleMessage(ws, msg, setKey) {
  if (['shutdown-step', 'status', 'pong', 'ping', 'ha-maintenance-disabled', 'ha-maintenance-disable-error'].includes(msg.type)
    && (!msg.machineKey || connections.get(msg.machineKey) !== ws)) return
  switch (msg.type) {
    case 'enroll':
      await handleEnroll(ws, msg)
      break
    case 'register':
      await handleRegister(ws, msg, setKey)
      break
    case 'shutdown-ack':
      await handleStateUpdate(msg.machineKey, 'command-received')
      break
    case 'shutdown-step':
      await handleShutdownStep(msg)
      break
    case 'shutdown-error':
      await handleStateUpdate(msg.machineKey, 'error', msg.error)
      break
    case 'ping':
      await handlePong(msg.machineKey)
      break
    case 'ha-maintenance-disabled':
    case 'ha-maintenance-disable-error': {
      const machine = await AgentMachine.findOne({ where: { machineKey: msg.machineKey } })
      await recovery.acknowledge(machine, msg)
      break
    }
    case 'pong':
      await handlePong(msg.machineKey)
      break
    case 'ha-frozen':
      await handleStateUpdate(msg.machineKey, 'shutting-down', 'HA frozen')
      break
    case 'status':
      await handleStatus(msg)
      break
    case 'nut-reprobe-result':
      handleAgentResponse(msg)
      break
    default:
      // unknown message type — ignore
  }
}

async function handleEnroll(ws, msg) {
  const { token } = msg
  if (!token) { ws.close(1008, 'missing token'); return }

  const machine = await AgentMachine.findOne({ where: { enrollmentToken: token } })
  if (!machine) { ws.close(1008, 'invalid token'); return }
  if (machine.enrollmentExpiry && new Date() > machine.enrollmentExpiry) {
    ws.close(1008, 'token expired'); return
  }

  const machineKey = machine.machineKey || require('crypto').randomUUID()
  await machine.update({
    machineKey,
    enrollmentToken: null,
    enrollmentExpiry: null,
    state: 'offline',
  })

  ws.send(JSON.stringify({ type: 'enrolled', machineKey }))
}

async function handleRegister(ws, msg, setKey) {
  const { machineKey, hostname, role, virtualization, os, agentVersion, capabilities, clusterId, clusterVotes } = msg
  if (!machineKey) { ws.close(1008, 'missing machineKey'); return }

  const machine = await AgentMachine.findOne({ where: { machineKey } })
  if (!machine) { ws.close(1008, 'unknown machineKey'); return }

  const updates = {
    hostname, virtualization, os, agentVersion,
    capabilities: capabilities || [],
    lastSeen: new Date(),
  }
  if (shouldAcceptAgentRole(machine, role)) updates.role = role
  // Only update cluster fields if agent reports them; preserve DB values if not sent.
  // upsGroupId is server-authoritative (set via PUT /api/agents/:id) — never overwrite from register.
  if (typeof clusterId === 'string' && clusterId.trim()) updates.clusterId = clusterId.trim()
  if (Number.isInteger(clusterVotes) && clusterVotes > 0) updates.clusterVotes = clusterVotes

  await machine.update(updates)
  await setState(machine, 'online')

  connections.set(machineKey, ws)
  setKey(machineKey)
  await recovery.recordOwnership(machine, msg.maintenanceRecovery)
  await recovery.restorePolicies(machine)
  await recovery.reconcileMachine(machineKey)
}

function shouldAcceptAgentRole(machine, role) {
  if (!role) return false
  if (!AgentMachine.VALID_ROLES.includes(role)) return false
  if (!machine.lastSeen && (!machine.role || machine.role === 'controlled')) return true
  return machine.role === role
}

async function handleStateUpdate(machineKey, newState, detail = null) {
  if (!machineKey) return
  const machine = await AgentMachine.findOne({ where: { machineKey } })
  if (machine) await setState(machine, newState, detail)
}

async function handleShutdownStep(msg) {
  const detail = `${msg.step} — ${msg.done} of ${msg.total}`
  await handleStateUpdate(msg.machineKey, 'shutting-down', detail)
  if (msg.step === 'enabling HA maintenance') {
    const machine = await AgentMachine.findOne({ where: { machineKey: msg.machineKey } })
    await recovery.recordOwnership(machine, msg.maintenanceRecovery)
  }
}

async function handlePong(machineKey) {
  if (!machineKey) return
  const machine = await AgentMachine.findOne({ where: { machineKey } })
  if (machine) await machine.update({ lastSeen: new Date() })
  hub.emit(`pong:${machineKey}`)
  await recovery.reconcileMachine(machineKey)
}

async function handleStatus(msg) {
  if (!msg.machineKey) return
  const machine = await AgentMachine.findOne({ where: { machineKey: msg.machineKey } })
  if (!machine) return
  await machine.update({ lastSeen: new Date(), agentVersion: msg.agentVersion || machine.agentVersion })
  if (msg.nutHealth && machine.upsGroupId) {
    const device = await Device.findByPk(machine.upsGroupId)
    if (device) await device.update({ nutHealth: msg.nutHealth })
  }
  await recovery.reconcileMachine(msg.machineKey)
}

async function setState(machine, newState, detail = null) {
  const fromState = machine.state
  if (fromState === newState && !detail) return
  await machine.update({ state: newState, stateDetail: detail, lastSeen: new Date() })
  await AgentMachineEvent.create({ agentMachineId: machine.id, fromState, toState: newState, detail })
}

function sendToMachine(machineKey, payload) {
  const ws = connections.get(machineKey)
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  ws.send(JSON.stringify(payload))
  return true
}

function handleAgentResponse(msg) {
  if (!msg.requestId) return
  hub.emit(`response:${msg.requestId}`, msg)
}

function requestMachine(machineKey, payload, options = {}) {
  const requestId = payload.requestId || crypto.randomUUID()
  const timeoutMs = options.timeoutMs || 30000

  return new Promise((resolve, reject) => {
    const event = `response:${requestId}`
    const timer = setTimeout(() => {
      hub.removeListener(event, onResponse)
      reject(new Error('Agent response timed out'))
    }, timeoutMs)

    function onResponse(msg) {
      clearTimeout(timer)
      resolve(msg)
    }

    hub.once(event, onResponse)
    const sent = sendToMachine(machineKey, { ...payload, requestId })
    if (!sent) {
      clearTimeout(timer)
      hub.removeListener(event, onResponse)
      reject(new Error('Agent not connected'))
    }
  })
}

async function notifyShutdown(deviceId) {
  // Find all active agents directly on this UPS circuit
  const directlyAffected = await AgentMachine.findAll({
    where: { active: true, upsGroupId: deviceId },
  })

  if (directlyAffected.length === 0) return

  // Partition affected agents into cluster vs non-cluster
  const clusterIds = [...new Set(
    directlyAffected.filter((m) => m.clusterId).map((m) => m.clusterId),
  )]

  const shutdownId = crypto.randomUUID()
  const existing = await PowerEvent.findOne({ where: { deviceId, state: 'active' } })
  const event = existing || await PowerEvent.create({ deviceId, shutdownId })

  // signalMap: machineKey → machine (deduplicates machines that might appear in multiple scopes)
  const signalMap = new Map()
  // Persist the actual shutdown scope; cluster-policy helpers do not own node flags.

  for (const clusterId of clusterIds) {
    // Load ALL nodes in the cluster (not just affected ones) for quorum calculation
    const allClusterNodes = await AgentMachine.findAll({
      where: { active: true, clusterId },
    })

    const { scope, reason } = buildShutdownScope({
      nodes: allClusterNodes,
      failingUpsGroupId: deviceId,
    })

    console.log(`[agentHub] Cluster ${clusterId}: ${reason}`)

    // Freeze HA using any reachable pve-node that has pveConfig
    const pveNode = allClusterNodes.find(
      (m) => m.role === 'pve-node' && m.pveConfig && connections.has(m.machineKey),
    )
    if (pveNode) {
      try {
        await setState(pveNode, 'ha-freezing')
        const opts = await proxmoxService.getClusterOptions(pveNode.pveConfig)
        const ha = opts?.ha == null ? null : String(opts.ha)
        await recovery.capturePolicy(event, clusterId, ha)
        if (ha && !event.previousHaPolicy) await event.update({ previousHaPolicy: ha })
        await proxmoxService.freezeHa(pveNode.pveConfig)
        console.log(`[agentHub] HA frozen for cluster ${clusterId} via ${pveNode.hostname}`)
      } catch (err) {
        console.error(`[agentHub] HA freeze failed for cluster ${clusterId}: ${err.message}`)
        // Graceful degradation — proceed with shutdown even if HA freeze fails
      }
    } else {
      console.warn(`[agentHub] No reachable pve-node with pveConfig in cluster ${clusterId} — skipping HA freeze`)
    }

    for (const m of scope) signalMap.set(m.machineKey, m)
  }

  // Add non-cluster machines (directly affected, no clusterId)
  for (const m of directlyAffected.filter((m) => !m.clusterId)) {
    signalMap.set(m.machineKey, m)
  }

  await event.update({ shutdownMachineKeys: [...signalMap.keys()] })

  // Send durable shutdown schedule to all machines simultaneously
  await Promise.all([...signalMap.values()].map(async (m) => {
    if (!connections.has(m.machineKey)) return
    await setState(m, 'command-sent')
    const delaySeconds = m.shutdownDelay || 0
    sendToMachine(m.machineKey, {
      type: 'schedule-shutdown',
      shutdownId: event.shutdownId,
      reason: 'ups-critical',
      deviceId,
      delaySeconds,
      executeAt: new Date(Date.now() + delaySeconds * 1000).toISOString(),
    })
  }))
}

async function notifyPowerRestored(deviceId) {
  const device = await Device.findByPk(deviceId)
  if (!freshOnline(device, Date.now())) return
  const event = await PowerEvent.findOne({ where: { deviceId, state: 'active' } })
  if (!event) return
  // Cancelling a shutdown is separate from durable HA recovery completion.
  await event.update({ state: 'cancelled', resolvedAt: new Date() })
  let keys = event.shutdownMachineKeys || []
  if (!keys.length) {
    // Old events may cancel their schedules but cannot establish node ownership.
    const affected = await AgentMachine.findAll({ where: { active: true, upsGroupId: deviceId } })
    keys = affected.map(machine => machine.machineKey)
  }
  for (const machineKey of keys) {
    sendToMachine(machineKey, { type: 'cancel-shutdown', shutdownId: event.shutdownId, deviceId, reason: 'power-restored' })
    const machine = await AgentMachine.findOne({ where: { machineKey, active: true } })
    if (machine) await recovery.restorePolicies(machine)
    await recovery.reconcileMachine(machineKey)
  }
}

function getConnectedCount() {
  return connections.size
}

// Expose EventEmitter methods so callers can listen for pong events
hub.attach = attach
hub.detach = detach
hub.sendToMachine = sendToMachine
hub.requestMachine = requestMachine
hub.notifyShutdown = notifyShutdown
hub.notifyPowerRestored = notifyPowerRestored
hub.getConnectedCount = getConnectedCount
hub.reconcilePowerRecovery = recovery.reconcileDevice
hub.setState = setState

module.exports = hub
