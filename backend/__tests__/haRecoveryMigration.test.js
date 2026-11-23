process.env.DB_PATH = ':memory:'
const { sequelize, initDatabase } = require('../config/database')
const PowerEvent = require('../models/PowerEvent')
const HaRecovery = require('../models/HaRecovery')
afterAll(async () => sequelize.close())
test('additive schema initialization preserves legacy events and unrelated operator columns', async () => {
  await sequelize.query(`CREATE TABLE PowerEvents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, deviceId INTEGER NOT NULL, shutdownId TEXT NOT NULL,
    state TEXT DEFAULT 'active', startedAt DATETIME, resolvedAt DATETIME, previousHaPolicy TEXT,
    haPreparedMachineKeys JSON, createdAt DATETIME, updatedAt DATETIME, operatorNote TEXT)`)
  await sequelize.query('INSERT INTO PowerEvents (deviceId,shutdownId,state,startedAt,haPreparedMachineKeys,operatorNote) VALUES ($device,$shutdown,$state,$started,$keys,$note)',
    { bind: { device: 1, shutdown: 'legacy-event', state: 'cancelled', started: new Date().toISOString(), keys: '["legacy-node"]', note: 'retain me' } })
  await initDatabase()
  const event = await PowerEvent.findOne()
  expect(event.shutdownId).toBe('legacy-event')
  expect(event.haPreparedMachineKeys).toEqual(['legacy-node'])
  expect(event.shutdownMachineKeys).toEqual([])
  expect(event.haPolicySnapshots).toEqual({})
  const [rows] = await sequelize.query('SELECT operatorNote FROM PowerEvents')
  expect(rows[0].operatorNote).toBe('retain me')
  const record = { shutdownId: 'new-event', deviceId: 1, machineKey: 'node', node: 'pve3' }
  await HaRecovery.create(record)
  await expect(HaRecovery.create(record)).rejects.toThrow()
})
