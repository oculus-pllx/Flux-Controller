process.env.DB_PATH = ':memory:'
jest.mock('../services/proxmoxService', () => ({ clusterQuorate: jest.fn(async () => true),
  restoreHaPolicy: jest.fn(async () => {}), getClusterOptions: jest.fn(async () => ({ ha: 'shutdown_policy=conditional' })) }))
const http = require('http')
const WebSocket = require('ws')
const { sequelize } = require('../config/database')
const Device = require('../models/Device')
const AgentMachine = require('../models/AgentMachine')
require('../models/AgentMachineEvent')
const PowerEvent = require('../models/PowerEvent')
const HaRecovery = require('../models/HaRecovery')
const hub = require('../services/agentHub')
let server, port, sockets, device, event
async function eventually(condition) {
  const deadline = Date.now() + 2000
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error('Expected recovery did not occur')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
beforeAll(async () => {
  await sequelize.sync({ force: true })
  server = http.createServer(); hub.attach(server)
  await new Promise(resolve => server.listen(0, resolve)); port = server.address().port
})
afterAll(async () => { hub.detach(); await new Promise(resolve => server.close(resolve)); await sequelize.close() })
beforeEach(async () => {
  sockets = []
  for (const model of Object.values(sequelize.models)) await model.destroy({ where: {}, truncate: true })
  device = await Device.create({ name: 'UPS', host: 'localhost', lastSeen: new Date(), lastStatus: { 'ups.status': 'OL' } })
  await AgentMachine.create({ machineKey: 'node-key', hostname: 'pve3', role: 'pve-node', active: true,
    clusterId: 'sms', upsGroupId: device.id, capabilities: ['ha-maintenance-recovery-v1'], pveConfig: { node: 'pve3' } })
  event = await PowerEvent.create({ deviceId: device.id, shutdownId: 'outage-1', state: 'active', shutdownMachineKeys: ['node-key'] })
})
afterEach(async () => { for (const socket of sockets) socket.terminate(); await new Promise(resolve => setTimeout(resolve, 40)) })
async function client(register = true) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/agent`)
  sockets.push(socket)
  const messages = []; socket.on('message', raw => messages.push(JSON.parse(raw)))
  await new Promise(resolve => socket.once('open', resolve))
  if (register) socket.send(JSON.stringify({ type: 'register', machineKey: 'node-key', hostname: 'pve3',
    role: 'pve-node', capabilities: ['ha-maintenance-recovery-v1'],
    maintenanceRecovery: { shutdownId: event.shutdownId, deviceId: device.id, node: 'pve3', phase: 'owned' } }))
  return { socket, messages }
}
test('power restores while offline, late registration replays cleanup and matching acknowledgement completes it', async () => {
  await hub.notifyPowerRestored(device.id)
  const { socket, messages } = await client()
  await eventually(() => messages.some(message => message.type === 'disable-ha-maintenance'))
  const command = messages.find(message => message.type === 'disable-ha-maintenance')
  socket.send(JSON.stringify({ ...command, type: 'ha-maintenance-disabled', machineKey: 'node-key', phase: 'cleared' }))
  await eventually(async () => (await HaRecovery.findOne())?.state === 'complete')
})
test('unregistered sockets cannot forge recovery acknowledgements', async () => {
  await hub.notifyPowerRestored(device.id)
  const { messages } = await client()
  await eventually(() => messages.some(message => message.type === 'disable-ha-maintenance'))
  const command = messages.find(message => message.type === 'disable-ha-maintenance')
  const { socket } = await client(false)
  socket.send(JSON.stringify({ ...command, type: 'ha-maintenance-disabled', machineKey: 'node-key', phase: 'cleared' }))
  await new Promise(resolve => setTimeout(resolve, 60))
  expect((await HaRecovery.findOne()).state).toBe('requested')
})
test('authenticated heartbeat retries durable pending work without a new power transition', async () => {
  await hub.notifyPowerRestored(device.id)
  const { socket, messages } = await client()
  await eventually(() => messages.some(message => message.type === 'disable-ha-maintenance'))
  await (await HaRecovery.findOne()).update({ requestedAt: new Date(Date.now() - 31000) })
  socket.send(JSON.stringify({ type: 'ping', machineKey: 'node-key' }))
  await eventually(() => messages.filter(message => message.type === 'disable-ha-maintenance').length === 2)
})
test('reconnecting legacy agent with null cluster fields cannot erase the configured recovery scope', async () => {
  const { socket } = await client(false)
  socket.send(JSON.stringify({ type: 'register', machineKey: 'node-key', hostname: 'pve3', role: 'pve-node',
    clusterId: null, clusterVotes: null, capabilities: [] }))
  await eventually(async () => (await AgentMachine.findOne())?.state === 'online')
  expect((await AgentMachine.findOne()).clusterId).toBe('sms')
})
