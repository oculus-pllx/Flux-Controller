const { DataTypes } = require('sequelize')
const { sequelize } = require('../config/database')

module.exports = sequelize.define('HaRecovery', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  shutdownId: { type: DataTypes.STRING, allowNull: false },
  deviceId: { type: DataTypes.INTEGER, allowNull: false },
  machineKey: { type: DataTypes.STRING, allowNull: false },
  node: { type: DataTypes.STRING, allowNull: false },
  state: { type: DataTypes.STRING, allowNull: false, defaultValue: 'pending' },
  requestId: { type: DataTypes.STRING, allowNull: true },
  requestedAt: { type: DataTypes.DATE, allowNull: true },
  completedAt: { type: DataTypes.DATE, allowNull: true },
  lastError: { type: DataTypes.STRING, allowNull: true },
}, { indexes: [{ unique: true, fields: ['shutdownId', 'machineKey'] }] })
