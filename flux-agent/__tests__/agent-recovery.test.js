jest.mock('../services/ws-client', () => ({ send: jest.fn() }))
jest.mock('../services/enrollment', () => ({ getConfig: jest.fn(() => ({ machineKey: 'node-key', pveConfig: { node: 'pve3' } })) }))
jest.mock('../services/ha-maintenance', () => ({ recover: jest.fn(), report: jest.fn() }))
jest.mock('../services/proxmox', () => ({ disableNodeMaintenance: jest.fn() }))
const client = require('../services/ws-client')
const ownership = require('../services/ha-maintenance')
const { handleMessage } = require('../agent')
beforeEach(() => jest.clearAllMocks())
const request = { type: 'disable-ha-maintenance', requestId: 'request-1', shutdownId: 'outage-1', deviceId: 3, node: 'pve3' }
test('clear command must pass through ownership helper and acknowledge verified phase', async () => {
  ownership.recover.mockResolvedValue({ phase: 'cleared' })
  await handleMessage(request)
  expect(ownership.recover).toHaveBeenCalledWith(expect.objectContaining({ message: request }))
  expect(client.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'ha-maintenance-disabled',
    machineKey: 'node-key', requestId: 'request-1', shutdownId: 'outage-1', deviceId: 3, node: 'pve3', phase: 'cleared' }))
})
test('failed ownership or quorum check produces an error acknowledgement without claiming success', async () => {
  ownership.recover.mockRejectedValue(new Error('not owned'))
  await handleMessage(request)
  expect(client.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'ha-maintenance-disable-error', requestId: 'request-1' }))
  expect(client.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ha-maintenance-disabled' }))
})
