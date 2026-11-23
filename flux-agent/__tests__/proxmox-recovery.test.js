jest.mock('child_process', () => ({ exec: jest.fn(), execFile: jest.fn() }))
jest.mock('fs', () => ({ ...jest.requireActual('fs'), readFileSync: jest.fn() }))
const fs = require('fs')
const { execFile } = require('child_process')
const proxmox = require('../services/proxmox')
beforeEach(() => {
  jest.clearAllMocks()
  fs.readFileSync.mockReturnValue(JSON.stringify({ timestamp: Date.now() / 1000,
    node_status: { pve3: 'online' }, node_request: {} }))
  execFile.mockImplementation((file, args, options, callback) => callback(null, JSON.stringify([{ type: 'cluster', quorate: 1 }])))
})
test('reads local HA requests and cluster quorum with a fixed read-only CLI', async () => {
  expect(await proxmox.maintenanceState({ node: 'pve3' })).toEqual({ maintenance: false, quorate: true })
  expect(execFile).toHaveBeenCalledWith('pvesh', ['get', '/cluster/status', '--output-format', 'json'],
    expect.objectContaining({ timeout: 10000 }), expect.any(Function))
})
test('pending maintenance request counts even before LRM transition', async () => {
  fs.readFileSync.mockReturnValue(JSON.stringify({ timestamp: Date.now() / 1000,
    node_status: { pve3: 'online' }, node_request: { pve3: { maintenance: 1 } } }))
  expect((await proxmox.maintenanceState({ node: 'pve3' })).maintenance).toBe(true)
})
test('missing nodes, stale state, malformed state and bad node names fail closed', async () => {
  for (const state of [{}, { timestamp: 1, node_status: { pve3: 'online' } },
    { timestamp: Date.now()/1000, node_status: {} }]) {
    fs.readFileSync.mockReturnValue(JSON.stringify(state))
    await expect(proxmox.maintenanceState({ node: 'pve3' })).rejects.toThrow()
  }
  await expect(proxmox.maintenanceState({ node: 'pve3;bad' })).rejects.toThrow()
})
