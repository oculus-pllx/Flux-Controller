const fs = require('fs')
const path = require('path')

const STATE_FILE = '/etc/flux-agent/ha-maintenance.json'
let operation = Promise.resolve()
function serialize(action) {
  const result = operation.then(action)
  operation = result.catch(() => {})
  return result
}
function read(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
function write(stateFile, state) {
  const directory = path.dirname(stateFile)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = stateFile + '.tmp'
  const fd = fs.openSync(temporary, 'w', 0o600)
  try {
    fs.fchmodSync(fd, 0o600)
    fs.writeFileSync(fd, JSON.stringify(state) + '\n')
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  fs.renameSync(temporary, stateFile)
  const parent = fs.openSync(directory, 'r')
  try { fs.fsyncSync(parent) } finally { fs.closeSync(parent) }
}
function report({ cfg, stateFile = STATE_FILE }) {
  if (!cfg.pveConfig) return null
  let state
  try { state = read(stateFile) } catch { return { node: cfg.pveConfig.node, phase: 'unknown' } }
  if (!state || state.node !== cfg.pveConfig.node) return null
  return Object.fromEntries(['shutdownId', 'deviceId', 'node', 'phase'].map(key => [key, state[key]]))
}
async function confirm(proxmox, cfg, expected, { verifyAttempts = 60,
  wait = () => new Promise(resolve => setTimeout(resolve, 250)) } = {}) {
  for (let attempt = 0; attempt < verifyAttempts; attempt++) {
    const state = await proxmox.maintenanceState(cfg.pveConfig)
    if (!state.quorate) throw new Error('Cluster has no quorum')
    if (state.maintenance === expected) return
    if (attempt + 1 < verifyAttempts) await wait()
  }
  throw new Error('HA maintenance confirmation timed out')
}
function prepare(options) {
  return serialize(async () => {
    const { cfg, shutdown, stateFile = STATE_FILE, proxmox = require('./proxmox') } = options
    const previous = read(stateFile)
    const status = await proxmox.maintenanceState(cfg.pveConfig)
    if (status.maintenance) {
      if (previous && previous.node === cfg.pveConfig.node && previous.phase !== 'cleared') return previous
      const external = { shutdownId: shutdown?.shutdownId || null, deviceId: shutdown?.deviceId || null,
        node: cfg.pveConfig.node, phase: 'external' }
      write(stateFile, external)
      return external
    }
    // Legacy immediate shutdowns have no correlatable event: retain their behavior
    // but never manufacture recovery ownership for them.
    if (!shutdown?.shutdownId || !Number.isInteger(shutdown.deviceId) || shutdown.deviceId < 1) {
      await proxmox.enableNodeMaintenance(cfg.pveConfig)
      return { node: cfg.pveConfig.node, phase: 'untracked' }
    }
    const state = { shutdownId: shutdown.shutdownId, deviceId: shutdown.deviceId,
      node: cfg.pveConfig.node, phase: 'intent' }
    write(stateFile, state)
    await proxmox.enableNodeMaintenance(cfg.pveConfig)
    await confirm(proxmox, cfg, true, options)
    state.phase = 'owned'
    write(stateFile, state)
    return state
  })
}
function recover(options) {
  return serialize(async () => {
    const { cfg, message, stateFile = STATE_FILE, proxmox = require('./proxmox') } = options
    const state = read(stateFile)
    if (!state || !['owned', 'clearing', 'cleared'].includes(state.phase) || state.node !== cfg.pveConfig?.node
      || message.node !== state.node || message.shutdownId !== state.shutdownId || message.deviceId !== state.deviceId) {
      throw new Error('Matching Flux maintenance ownership required')
    }
    const expiresAt = Date.parse(message.expiresAt)
    if (typeof message.requestId !== 'string' || !message.requestId || !Number.isFinite(expiresAt)
      || expiresAt <= Date.now() || expiresAt > Date.now() + 60000) throw new Error('Invalid recovery request')
    // Keep a durable tombstone: replay must never clear a later manual flag.
    if (state.phase === 'cleared') return state
    const pendingFile = path.join(path.dirname(stateFile), 'pending-shutdown.json')
    if (read(pendingFile)) throw new Error('A shutdown is pending')
    const status = await proxmox.maintenanceState(cfg.pveConfig)
    if (!status.quorate) throw new Error('Cluster has no quorum')
    if (Date.now() >= expiresAt) throw new Error('Recovery request expired')
    if (read(pendingFile)) throw new Error('A shutdown is pending')
    if (state.phase === 'clearing' && status.maintenance) throw new Error('Previous clear outcome is ambiguous; ownership review required')
    if (status.maintenance) {
      state.phase = 'clearing'
      write(stateFile, state)
      await proxmox.disableNodeMaintenance(cfg.pveConfig)
    }
    await confirm(proxmox, cfg, false, options)
    state.phase = 'cleared'
    write(stateFile, state)
    return state
  })
}
module.exports = { prepare, recover, report, STATE_FILE }
