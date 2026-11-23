process.env.DB_PATH = ':memory:'
const { sequelize } = require('../config/database')
const Device = require('../models/Device')
const AgentMachine = require('../models/AgentMachine')
const PowerEvent = require('../models/PowerEvent')
const { createRecoveryService } = require('../services/haRecoveryService')
let service, machine, event, device, send, pve, now
beforeAll(async () => { await sequelize.sync({ force: true }) })
afterAll(async () => { await sequelize.close() })
beforeEach(async () => {
  for (const model of Object.values(sequelize.models)) await model.destroy({ where: {}, truncate: true })
  now = Date.now()
  device = await Device.create({ name: 'UPS', host: 'localhost', lastSeen: new Date(now),
    lastStatus: { 'ups.status': 'OL' }, shutdownActive: false })
  machine = await AgentMachine.create({ machineKey: 'node-key', hostname: 'pve3', active: true,
    role: 'pve-node', clusterId: 'sms', upsGroupId: device.id,
    capabilities: ['ha-maintenance-recovery-v1'], pveConfig: { node: 'pve3' } })
  event = await PowerEvent.create({ deviceId: device.id, shutdownId: 'outage-1', state: 'cancelled',
    shutdownMachineKeys: ['node-key'] })
  send = jest.fn(() => true)
  pve = { clusterQuorate: jest.fn(async () => true), restoreHaPolicy: jest.fn(async () => {}), getClusterOptions: jest.fn(async () => ({ ha: 'shutdown_policy=conditional' })) }
  service = createRecoveryService({ sendToMachine: send, proxmox: pve, clock: () => now })
})
async function own(extra = {}) {
  return service.recordOwnership(machine, { shutdownId: event.shutdownId, deviceId: device.id,
    node: 'pve3', phase: 'owned', ...extra })
}
async function row() { return sequelize.models.HaRecovery ? sequelize.models.HaRecovery.findOne() : null }
function acknowledgement(command, extra = {}) {
  return { ...command, type: 'ha-maintenance-disabled', phase: 'cleared', ...extra }
}

test('persists pending cleanup for an offline node, then sends on authenticated reconnect', async () => {
  await own()
  expect(await row()).toMatchObject({ state: 'pending' })
  await service.reconcileMachine(machine.machineKey)
  expect(send).toHaveBeenCalledWith('node-key', expect.objectContaining({ type: 'disable-ha-maintenance', shutdownId: 'outage-1', node: 'pve3' }))
  expect(await row()).toMatchObject({ state: 'requested' })
})
test('completed acknowledgement is required; duplicates are idempotent', async () => {
  await own(); await service.reconcileMachine(machine.machineKey)
  const command = send.mock.calls[0]?.[1] || {}
  await service.acknowledge(machine, acknowledgement(command))
  expect(await row()).toMatchObject({ state: 'complete' })
  await service.acknowledge(machine, acknowledgement(command))
  await service.reconcileMachine(machine.machineKey)
  expect(send).toHaveBeenCalledTimes(1)
})
test('lost acknowledgement survives service restart and retries after a bounded interval', async () => {
  await own(); await service.reconcileMachine(machine.machineKey)
  const first = send.mock.calls[0]?.[1]
  service = createRecoveryService({ sendToMachine: send, proxmox: pve, clock: () => now })
  await service.reconcileMachine(machine.machineKey)
  expect(send).toHaveBeenCalledTimes(1)
  now += 31000
  await device.update({ lastSeen: new Date(now) })
  await service.reconcileMachine(machine.machineKey)
  expect(send).toHaveBeenCalledTimes(2)
  expect(send.mock.calls[1][1].requestId).not.toBe(first.requestId)
})
test('failed or forged acknowledgement never completes cleanup', async () => {
  await own(); await service.reconcileMachine(machine.machineKey)
  const command = send.mock.calls[0]?.[1] || {}
  for (const change of [{ node: 'wrong' }, { shutdownId: 'wrong' }, { requestId: 'wrong' }, { deviceId: 999 }, { phase: 'owned' }]) {
    await service.acknowledge(machine, acknowledgement(command, change))
    expect((await row())?.state).toBe('requested')
  }
  await service.acknowledge(machine, { ...command, type: 'ha-maintenance-disable-error' })
  expect((await row())?.state).toBe('pending')
  await service.reconcileMachine(machine.machineKey)
  expect(send).toHaveBeenCalledTimes(1)
})
test.each(['', 'UNKNOWN', 'OB', 'OL OB', 'OL LB', 'OL FSD', 'NOTOL'])('does not recover unsafe UPS status %s', async status => {
  await own(); await device.update({ lastStatus: { 'ups.status': status } })
  await service.reconcileMachine(machine.machineKey)
  expect(send).not.toHaveBeenCalled()
})
test('stale, future or failed UPS samples and disabled devices cannot recover', async () => {
  await own()
  for (const change of [{ lastSeen: new Date(now - 3600000) }, { lastSeen: new Date(now + 3600000) },
    { lastSeen: new Date(now), nutHealth: { state: 'error' } }, { nutHealth: null, active: false }]) {
    await device.update(change); await service.reconcileMachine(machine.machineKey)
  }
  expect(send).not.toHaveBeenCalled()
})
test('manual, interrupted, unscoped, legacy and wrong-node records do not become owned', async () => {
  await own({ phase: 'external' }); expect(await row()).toBeNull()
  await own({ phase: 'intent' }); expect(await row()).toBeNull()
  await own({ node: 'pve5' }); expect(await row()).toBeNull()
  await event.update({ shutdownMachineKeys: [] })
  await own(); expect(await row()).toBeNull()
})
test('a second outage suspends prior recovery until its own power is restored', async () => {
  await own()
  const another = await PowerEvent.create({ deviceId: device.id, shutdownId: 'outage-2', state: 'active', shutdownMachineKeys: ['node-key'] })
  await service.reconcileMachine(machine.machineKey)
  expect(send).not.toHaveBeenCalled()
  await another.update({ state: 'cancelled' })
  await service.reconcileMachine(machine.machineKey)
  expect(send).toHaveBeenCalledTimes(1)
})
test('unknown or unsupported agent cannot trigger recovery, and repeated ownership reports cannot reopen completed work', async () => {
  await machine.update({ capabilities: [] })
  await own(); expect(await row()).toBeNull()
  await machine.update({ capabilities: ['ha-maintenance-recovery-v1'] })
  await own(); await service.reconcileDevice(device.id)
  const command = send.mock.calls[0]?.[1] || {}
  await service.acknowledge(machine, acknowledgement(command))
  await own(); await service.reconcileDevice(device.id)
  expect((await row())?.state).toBe('complete')
  expect(send).toHaveBeenCalledTimes(1)
})
test('restores only the captured cluster policy and retries failures without claiming node maintenance', async () => {
  await service.capturePolicy(event, 'sms', 'shutdown_policy=conditional')
  await service.capturePolicy(event, 'other-cluster', 'shutdown_policy=freeze')
  await service.restorePolicies(machine)
  expect(pve.restoreHaPolicy).toHaveBeenCalledWith(machine.pveConfig, 'shutdown_policy=conditional')
  await event.reload()
  expect(event.haPolicySnapshots?.sms?.state).toBe('complete')
  expect(event.haPolicySnapshots?.['other-cluster']?.state).toBe('pending')
  expect(await row()).toBeNull()
})
test('overlapping outages retain the original cluster policy instead of recapturing Flux freeze', async () => {
  await service.capturePolicy(event, 'sms', 'shutdown_policy=conditional')
  const other = await PowerEvent.create({ deviceId: device.id, shutdownId: 'outage-2', state: 'active', shutdownMachineKeys: ['node-key'] })
  await service.capturePolicy(other, 'sms', 'shutdown_policy=freeze')
  await service.restorePolicies(machine)
  expect(pve.restoreHaPolicy).not.toHaveBeenCalled()
  await other.update({ state: 'cancelled' })
  await service.restorePolicies(machine)
  expect(pve.restoreHaPolicy).toHaveBeenCalledWith(machine.pveConfig, 'shutdown_policy=conditional')
})
test('quorum loss and an offline socket retain pending work without a clear', async () => {
  await own(); pve.clusterQuorate.mockResolvedValue(false)
  await service.reconcileMachine(machine.machineKey)
  expect(send).not.toHaveBeenCalled()
  pve.clusterQuorate.mockResolvedValue(true); send.mockReturnValue(false)
  await service.reconcileMachine(machine.machineKey)
  expect(await row()).toMatchObject({ state: 'pending', lastError: 'agent-offline' })
})
test('failed policy restoration or read-back blocks node cleanup and remains retryable', async () => {
  await own(); await service.capturePolicy(event, 'sms', 'shutdown_policy=conditional')
  pve.restoreHaPolicy.mockRejectedValueOnce(new Error('unreachable'))
  await service.reconcileMachine(machine.machineKey)
  expect(send).not.toHaveBeenCalled()
  pve.getClusterOptions.mockResolvedValue({ ha: 'shutdown_policy=freeze' })
  await service.reconcileMachine(machine.machineKey)
  expect(send).not.toHaveBeenCalled()
  pve.getClusterOptions.mockResolvedValue({ ha: 'shutdown_policy=conditional' })
  await service.reconcileMachine(machine.machineKey)
  expect(send).toHaveBeenCalledTimes(1)
})
test('an outage on another UPS in the same cluster blocks cleanup even with legacy empty scope', async () => {
  await own()
  const other = await Device.create({ name: 'Other UPS', host: 'other' })
  await AgentMachine.create({ machineKey: 'other-node', hostname: 'pve5', active: true, clusterId: 'sms', upsGroupId: other.id })
  await PowerEvent.create({ deviceId: other.id, shutdownId: 'other-power-event', state: 'active' })
  await service.reconcileMachine(machine.machineKey)
  expect(send).not.toHaveBeenCalled()
})
test('concurrent reconnect and poll attempts send only one request', async () => {
  await own()
  await Promise.all([service.reconcileMachine(machine.machineKey), service.reconcileDevice(device.id), service.reconcileMachine(machine.machineKey)])
  expect(send).toHaveBeenCalledTimes(1)
})
test('does not overwrite an operator policy changed after Flux froze HA', async () => {
  await service.capturePolicy(event, 'sms', 'shutdown_policy=conditional')
  pve.getClusterOptions.mockResolvedValue({ ha: 'shutdown_policy=migrate' })
  await service.restorePolicies(machine)
  expect(pve.restoreHaPolicy).not.toHaveBeenCalled()
  await event.reload()
  expect(event.haPolicySnapshots.sms.state).toBe('pending')
})
