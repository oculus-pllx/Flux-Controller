const fs = require('fs')
const os = require('os')
const path = require('path')
const recovery = require('../services/ha-maintenance')

let directory, stateFile, pve, cfg, shutdown
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-maintenance-'))
  stateFile = path.join(directory, 'recovery.json')
  cfg = { machineKey: 'node-key', pveConfig: { node: 'pve-3' } }
  shutdown = { shutdownId: 'outage-1', deviceId: 3 }
  let enabled = false
  pve = {
    maintenanceState: jest.fn(async () => ({ maintenance: enabled, quorate: true })),
    enableNodeMaintenance: jest.fn(async () => { enabled = true }),
    disableNodeMaintenance: jest.fn(async () => { enabled = false }),
  }
})
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))
function prepare() { return recovery.prepare({ cfg, shutdown, stateFile, proxmox: pve }) }
function message(extra = {}) {
  return { ...shutdown, node: 'pve-3', requestId: 'request-1', expiresAt: new Date(Date.now() + 10000).toISOString(), ...extra }
}
function recover(extra = {}) { return recovery.recover({ cfg, message: message(extra), stateFile, proxmox: pve }) }

test('records ownership durably only after enabling and verifying maintenance', async () => {
  expect(await prepare()).toMatchObject({ phase: 'owned', ...shutdown, node: 'pve-3' })
  expect(JSON.parse(fs.readFileSync(stateFile))).toMatchObject({ phase: 'owned' })
  expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600)
  expect(recovery.report({ cfg, stateFile })).toMatchObject({ phase: 'owned', ...shutdown })
})
test('does not claim maintenance already enabled manually', async () => {
  pve.maintenanceState.mockResolvedValue({ maintenance: true, quorate: true })
  expect(await prepare()).toMatchObject({ phase: 'external' })
  expect(pve.enableNodeMaintenance).not.toHaveBeenCalled()
  await expect(recover()).rejects.toThrow('ownership')
  expect(pve.disableNodeMaintenance).not.toHaveBeenCalled()
})
test('retains an ambiguous intent when enabling fails and refuses automatic clear', async () => {
  pve.enableNodeMaintenance.mockRejectedValue(new Error('failed'))
  await expect(prepare()).rejects.toThrow('failed')
  expect(recovery.report({ cfg, stateFile }).phase).toBe('intent')
  await expect(recover()).rejects.toThrow('ownership')
})
test('matching recovery verifies quorum and the cleared flag before acknowledging', async () => {
  await prepare()
  expect(await recover()).toMatchObject({ phase: 'cleared', ...shutdown })
  expect(pve.disableNodeMaintenance).toHaveBeenCalledTimes(1)
  expect(recovery.report({ cfg, stateFile }).phase).toBe('cleared')
})
test('duplicate clear does not clear later manually enabled maintenance', async () => {
  await prepare(); await recover()
  pve.maintenanceState.mockResolvedValue({ maintenance: true, quorate: true })
  expect((await recover()).phase).toBe('cleared')
  expect(pve.disableNodeMaintenance).toHaveBeenCalledTimes(1)
})
test('rejects wrong outage, device, node, missing request and expired request', async () => {
  await prepare()
  for (const change of [{ shutdownId: 'other' }, { deviceId: 4 }, { node: 'pve-5' },
    { requestId: null }, { expiresAt: 'bad' }, { expiresAt: new Date(0).toISOString() }]) {
    await expect(recover(change)).rejects.toThrow()
  }
  expect(pve.disableNodeMaintenance).not.toHaveBeenCalled()
})
test('refuses recovery without quorum and keeps owned state for retry', async () => {
  await prepare()
  pve.maintenanceState.mockResolvedValue({ maintenance: true, quorate: false })
  await expect(recover()).rejects.toThrow('quorum')
  expect(pve.disableNodeMaintenance).not.toHaveBeenCalled()
  expect(recovery.report({ cfg, stateFile }).phase).toBe('owned')
})
test('failed flag verification does not mark recovery complete', async () => {
  await prepare()
  pve.disableNodeMaintenance.mockImplementation(async () => {})
  await expect(recovery.recover({ cfg, message: message(), stateFile, proxmox: pve,
    verifyAttempts: 2, wait: async () => {} })).rejects.toThrow('confirmation')
  expect(recovery.report({ cfg, stateFile }).phase).toBe('clearing')
})
test('a new outage cannot overwrite unresolved ownership while maintenance is set', async () => {
  await prepare()
  const record = await recovery.prepare({ cfg, shutdown: { shutdownId: 'outage-2', deviceId: 5 }, stateFile, proxmox: pve })
  expect(record.shutdownId).toBe('outage-1')
  expect(pve.enableNodeMaintenance).toHaveBeenCalledTimes(1)
})
test('absence, corruption or different node ownership never permits a clear', async () => {
  expect(recovery.report({ cfg, stateFile })).toBeNull()
  await expect(recover()).rejects.toThrow('ownership')
  fs.writeFileSync(stateFile, '{')
  await expect(prepare()).rejects.toThrow()
  fs.writeFileSync(stateFile, JSON.stringify({ phase: 'owned', ...shutdown, node: 'pve-5' }))
  await expect(recover()).rejects.toThrow('ownership')
})
test('corrupt ownership is reported as unknown without disabling agent connectivity', () => {
  fs.writeFileSync(stateFile, '{')
  expect(recovery.report({ cfg, stateFile })).toMatchObject({ node: 'pve-3', phase: 'unknown' })
})
test('interrupted clear cannot replay over a later manual flag, but can acknowledge an already cleared node', async () => {
  await prepare()
  pve.disableNodeMaintenance.mockRejectedValue(new Error('connection lost'))
  await expect(recover()).rejects.toThrow()
  expect(recovery.report({ cfg, stateFile }).phase).toBe('clearing')
  await expect(recover()).rejects.toThrow('ambiguous')
  expect(pve.disableNodeMaintenance).toHaveBeenCalledTimes(1)
  pve.maintenanceState.mockResolvedValue({ maintenance: false, quorate: true })
  expect((await recover()).phase).toBe('cleared')
  expect(pve.disableNodeMaintenance).toHaveBeenCalledTimes(1)
})
test('a newly scheduled outage blocks an older in-flight recovery locally', async () => {
  await prepare()
  fs.writeFileSync(path.join(directory, 'pending-shutdown.json'), JSON.stringify({ shutdownId: 'outage-2' }))
  await expect(recover()).rejects.toThrow('shutdown')
  expect(pve.disableNodeMaintenance).not.toHaveBeenCalled()
})
