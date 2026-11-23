process.env.DB_PATH = ':memory:'

jest.mock('../services/nutService', () => ({
  pollDevice: jest.fn(),
}))
jest.mock('../services/alertService', () => ({
  evaluate: jest.fn(),
}))
jest.mock('../services/agentHub', () => ({
  notifyShutdown: jest.fn(),
  notifyPowerRestored: jest.fn(),
  reconcilePowerRecovery: jest.fn(),
}))

const { sequelize } = require('../config/database')
const Device = require('../models/Device')
require('../models/Metrics')
const nutService = require('../services/nutService')

beforeAll(async () => { await sequelize.sync({ force: true }) })
afterAll(async () => { await sequelize.close() })
beforeEach(() => jest.clearAllMocks())

describe('pollingService', () => {
  it('clears a stale polling error after the NUT source recovers', async () => {
    const device = await Device.create({
      name: 'Recovered UPS',
      host: '192.0.2.55',
      port: 3493,
      upsName: 'prism-ups',
      lastSeen: null,
      lastStatus: {},
      nutHealth: {
        state: 'error',
        sourceType: 'unknown',
        message: 'NUT polling failed: connect ECONNREFUSED 192.0.2.55:3493',
      },
    })
    nutService.pollDevice.mockResolvedValue({ 'ups.status': 'OL CHRG' })

    const { pollDeviceForTest } = require('../services/pollingService')
    await pollDeviceForTest(device)

    await device.reload()
    expect(device.lastStatus).toEqual({ 'ups.status': 'OL CHRG' })
    expect(device.lastSeen).not.toBeNull()
    expect(device.nutHealth).toBeNull()
  })


  it('marks a device offline when polling fails so stale online data is not shown', async () => {
    const device = await Device.create({
      name: 'Stale UPS',
      host: '10.11.200.24',
      port: 3493,
      upsName: 'apc2200',
      lastSeen: new Date('2026-06-24T19:00:00.000Z'),
      lastStatus: { 'ups.status': 'OL', 'ups.model': 'Old UPS' },
    })
    nutService.pollDevice.mockRejectedValue(new Error('DRIVER-NOT-CONNECTED'))

    const { pollDeviceForTest } = require('../services/pollingService')
    await pollDeviceForTest(device)

    await device.reload()
    expect(device.lastStatus).toEqual({})
    expect(device.nutHealth).toMatchObject({
      state: 'error',
      sourceType: 'unknown',
      message: 'NUT polling failed: DRIVER-NOT-CONNECTED',
    })
    expect(device.lastSeen).toBeNull()
  })
})

describe('power-restoration safety and durable retry', () => {
  it.each(['', 'UNKNOWN', 'NOTOL', 'OL OB', 'OL LB', 'OL FSD'])('does not treat %s as restored mains power', async status => {
    const device = await Device.create({ name: 'Unsafe recovery', host: 'localhost', shutdownActive: true })
    await require('../services/pollingService').checkAutoShutdownForTest(device, { 'ups.status': status })
    await device.reload()
    expect(device.shutdownActive).toBe(true)
    expect(require('../services/agentHub').notifyPowerRestored).not.toHaveBeenCalled()
  })
  it('reconciles prior pending cleanup on subsequent successful OL polls without another power transition', async () => {
    const device = await Device.create({ name: 'Recovered UPS', host: 'localhost', shutdownActive: false })
    await require('../services/pollingService').checkAutoShutdownForTest(device, { 'ups.status': 'OL CHRG' })
    expect(require('../services/agentHub').notifyPowerRestored).toHaveBeenCalledWith(device.id)
    expect(require('../services/agentHub').reconcilePowerRecovery).toHaveBeenCalledWith(device.id)
  })
})
