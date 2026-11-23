const { Op } = require('sequelize')
const crypto = require('crypto')
const HaRecovery = require('../models/HaRecovery')
const PowerEvent = require('../models/PowerEvent')
const AgentMachine = require('../models/AgentMachine')
const Device = require('../models/Device')

const CAPABILITY = 'ha-maintenance-recovery-v1'
const RETRY_MS = 30000
function onlinePower(status) {
  const tokens = typeof status === 'string' ? status.toUpperCase().trim().split(/\s+/) : []
  return tokens.includes('OL') && !tokens.some(token => ['OB', 'LB', 'FSD'].includes(token))
}
function freshOnline(device, now) {
  if (!device?.active || device.shutdownActive || device.nutHealth?.state === 'error') return false
  const age = now - new Date(device.lastSeen || 0).getTime()
  const maximum = Math.min(300000, Math.max(60000, (device.pollInterval || 30) * 2000 + 5000))
  return Number.isFinite(age) && age >= -5000 && age <= maximum && onlinePower(device.lastStatus?.['ups.status'])
}
function createRecoveryService({ sendToMachine, proxmox, clock = Date.now }) {
  let operation = Promise.resolve()
  function serial(action) {
    const result = operation.then(action)
    operation = result.catch(() => {})
    return result
  }
  async function noActiveOutage(machine) {
    const cluster = machine.clusterId
      ? await AgentMachine.findAll({ where: { active: true, clusterId: machine.clusterId } }) : [machine]
    const keys = new Set(cluster.map(node => node.machineKey))
    const devices = new Set(cluster.map(node => node.upsGroupId))
    const active = await PowerEvent.findAll({ where: { state: 'active' } })
    return !active.some(event => devices.has(event.deviceId)
      || (event.shutdownMachineKeys || []).some(key => keys.has(key)))
  }
  async function ready(event, machine) {
    return Boolean(event && event.state === 'cancelled' && machine?.active && machine.pveConfig
      && freshOnline(await Device.findByPk(event.deviceId), clock())
      && await noActiveOutage(machine) && await proxmox.clusterQuorate(machine.pveConfig))
  }
  async function recordOwnership(machine, record) {
    if (machine?.pveConfig && ['intent', 'clearing', 'unknown'].includes(record?.phase)) {
      await machine.update({ stateDetail: 'HA maintenance ownership requires review' })
      return
    }
    if (!machine?.active || !machine.capabilities?.includes(CAPABILITY) || !record
      || !['owned', 'cleared'].includes(record.phase) || typeof record.shutdownId !== 'string'
      || record.node !== machine.pveConfig?.node) return
    const event = await PowerEvent.findOne({ where: { shutdownId: record.shutdownId } })
    if (!event || record.deviceId !== event.deviceId || !(event.shutdownMachineKeys || []).includes(machine.machineKey)) return
    await HaRecovery.findOrCreate({ where: { shutdownId: event.shutdownId, machineKey: machine.machineKey },
      defaults: { deviceId: event.deviceId, node: record.node, state: 'pending' } })
  }
  async function capturePolicy(event, clusterId, policy) {
    if (!clusterId || !(policy === null || typeof policy === 'string')) return
    await event.reload()
    if (event.haPolicySnapshots?.[clusterId]) return
    const previous = await PowerEvent.findAll({ order: [['id', 'ASC']] })
    const pending = previous.map(entry => entry.haPolicySnapshots?.[clusterId]).find(snapshot => snapshot?.state === 'pending')
    await event.update({ haPolicySnapshots: { ...event.haPolicySnapshots,
      [clusterId]: { policy: pending ? pending.policy : policy, state: 'pending' } } })
  }
  async function restorePolicies(machine) {
    if (!machine?.clusterId || !machine.pveConfig || !await noActiveOutage(machine)) return
    const events = await PowerEvent.findAll({ where: { state: 'cancelled' }, order: [['id', 'ASC']] })
    const pending = events.filter(event => event.haPolicySnapshots?.[machine.clusterId]?.state === 'pending')
    if (!pending.length || !await Promise.all(pending.map(event => ready(event, machine))).then(results => results.every(Boolean))) return
    const policy = pending[0].haPolicySnapshots[machine.clusterId].policy
    try {
      const before = await proxmox.getClusterOptions(machine.pveConfig)
      if ((before?.ha ?? null) !== policy && before?.ha !== 'shutdown_policy=freeze') {
        throw new Error('HA policy changed outside Flux; review required')
      }
      await proxmox.restoreHaPolicy(machine.pveConfig, policy)
      const observed = await proxmox.getClusterOptions(machine.pveConfig)
      if ((observed?.ha ?? null) !== policy || !await noActiveOutage(machine)) throw new Error('HA policy verification failed')
      for (const event of pending) {
        await event.reload()
        await event.update({ haPolicySnapshots: { ...event.haPolicySnapshots,
          [machine.clusterId]: { policy, state: 'complete' } } })
      }
    } catch {
      // Keep the original snapshot durable. Do not lose recovery after a failed PUT.
      await machine.update({ stateDetail: 'HA policy recovery pending' })
    }
  }
  async function reconcileMachine(machineKey) {
    const machine = await AgentMachine.findOne({ where: { machineKey, active: true } })
    if (!machine?.capabilities?.includes(CAPABILITY)) return
    await restorePolicies(machine)
    const rows = await HaRecovery.findAll({ where: { machineKey, state: { [Op.in]: ['pending', 'requested'] } }, order: [['id', 'ASC']] })
    for (const row of rows) {
      if (row.requestedAt && clock() - new Date(row.requestedAt).getTime() < RETRY_MS) continue
      const event = await PowerEvent.findOne({ where: { shutdownId: row.shutdownId } })
      if (row.node !== machine.pveConfig?.node || !await ready(event, machine)) continue
      const policies = event.haPolicySnapshots || {}
      if (machine.clusterId && policies[machine.clusterId]?.state === 'pending') continue
      const requestId = crypto.randomUUID()
      await row.update({ state: 'requested', requestId, requestedAt: new Date(clock()), lastError: null })
      const sent = sendToMachine(machineKey, { type: 'disable-ha-maintenance', requestId,
        shutdownId: row.shutdownId, deviceId: row.deviceId, node: row.node,
        expiresAt: new Date(clock() + RETRY_MS).toISOString(), reason: 'power-restored' })
      if (!sent) await row.update({ state: 'pending', lastError: 'agent-offline' })
    }
  }
  async function reconcileDevice(deviceId) {
    const events = await PowerEvent.findAll({ where: { deviceId, state: 'cancelled' } })
    const keys = new Set(events.flatMap(event => event.shutdownMachineKeys || []))
    for (const key of keys) await reconcileMachine(key)
  }
  async function acknowledge(machine, message) {
    if (!machine || typeof message.shutdownId !== 'string') return
    const row = await HaRecovery.findOne({ where: { machineKey: machine.machineKey,
      shutdownId: message.shutdownId, state: 'requested' } })
    if (!row || row.requestId !== message.requestId || row.node !== message.node || row.deviceId !== message.deviceId) return
    if (message.type === 'ha-maintenance-disabled' && message.phase === 'cleared') {
      const event = await PowerEvent.findOne({ where: { shutdownId: row.shutdownId } })
      if (!await ready(event, machine)) return
      await row.update({ state: 'complete', completedAt: new Date(clock()), lastError: null })
    } else if (message.type === 'ha-maintenance-disable-error') {
      await row.update({ state: 'pending', lastError: 'agent-recovery-failed' })
      await machine.update({ stateDetail: 'HA maintenance recovery pending' })
    }
  }
  return Object.fromEntries(Object.entries({ recordOwnership, reconcileMachine, reconcileDevice,
    acknowledge, capturePolicy, restorePolicies }).map(([name, action]) => [name, (...args) => serial(() => action(...args))]))
}
module.exports = { createRecoveryService, onlinePower, freshOnline, CAPABILITY }
