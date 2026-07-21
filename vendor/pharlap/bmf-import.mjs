// Import-from-mint: fetch a collection tx by txid and recover its (decrypted, decompressed) content,
// reusing PharLap's PROVEN on-chain decoders (vendored alongside). Mirrors PharLap
// src/app.ts:fetchCollectionContent — Tier-1 keyless unwrap, self-verifying against the on-chain commitment.
//
// The .ts decoders are vendored copies of PharLap/src/{tokenCodec,contentCrypto,compress,pushDrop}.ts —
// keep them in sync when PharLap's on-chain format changes.
import { Transaction, Utils, Hash, PublicKey } from '@bsv/sdk'
import { parseFileScript, parseTemplateScript, decodeTokenRules, parseLegacyFileScript } from './tokenCodec.ts'
import { unwrapContentKey, decryptContent } from './contentCrypto.ts'
import { decompress } from './compress.ts'

// Find a legacy MPT-FILE / P-FILE payload across a tx's outputs (null if none). The decoder is shared with
// PharLap (vendored tokenCodec.parseLegacyFileScript) so both repos stay in sync — no drift.
function legacyFileFromTx (tx) {
  for (const o of tx.outputs) { const r = parseLegacyFileScript(o.lockingScript); if (r) return r }
  return null
}

// ── BMC set: a store-only ZIP of BMF media + a bmc.json index, minted as ONE collection ──
// A BMC's members stay referenceable by name ({ tx, name }). Only the store-only (no-deflate) ZIP that
// makeZip / the BMC tool produce is supported — which is all we mint.
const isBmc = b => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 // "PK\x03\x04"
function readStoreZip (bytes) {
  const u16 = o => bytes[o] | (bytes[o + 1] << 8)
  const u32 = o => bytes[o] + bytes[o + 1] * 0x100 + bytes[o + 2] * 0x10000 + bytes[o + 3] * 0x1000000
  const out = {}
  let i = 0
  while (i + 30 <= bytes.length && u32(i) === 0x04034b50) { // local file header
    const method = u16(i + 8), size = u32(i + 18), nameLen = u16(i + 26), extraLen = u16(i + 28)
    if (method !== 0) return null // store-only only
    const nameStart = i + 30
    let name = ''; for (let j = 0; j < nameLen; j++) name += String.fromCharCode(bytes[nameStart + j])
    const dataStart = nameStart + nameLen + extraLen
    out[name] = Array.from(bytes.slice(dataStart, dataStart + size))
    i = dataStart + size
  }
  return Object.keys(out).length ? out : null
}
// Parse decoded content as a BMC set → { name, members:[{name,file,mimeType,bytes}] } or null (not a set).
export function parseBmcSet (bytes) {
  if (!isBmc(bytes)) return null
  const files = readStoreZip(bytes)
  if (!files || !files['bmc.json']) return null
  try {
    const manifest = JSON.parse(Utils.toUTF8(files['bmc.json']))
    const members = (manifest.members || [])
      .map(m => ({ name: m.name, file: m.file, mimeType: m.mime || 'application/octet-stream', bytes: files[m.file] }))
      .filter(m => m.name && m.bytes && m.bytes.length)
    return members.length ? { name: manifest.name || 'set', members } : null
  } catch { return null }
}

// Raw tx hex. BananaBlocks-primary + WoC-fallback would slot in here; WoC for now.
async function fetchRawTxHex (txid) {
  const r = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`)
  if (!r.ok) throw new Error(`chain lookup failed (${r.status}) for ${txid}`)
  const hex = (await r.text()).trim()
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 20) throw new Error('not a valid transaction (is the txid correct?)')
  return hex
}

// Resolve a collection txid → { fileName, mimeType, bytes(number[]), encrypted, verified, sha256, rules }.
// Returns null if the tx carries no file (not a PharLap content collection).
export async function importCollection (txid, { fetchHex = fetchRawTxHex } = {}) {
  const tx = Transaction.fromHex(await fetchHex(txid))
  let file = null, template
  for (const o of tx.outputs) {
    const f = parseFileScript(o.lockingScript); if (f) file = f.fields
    const t = parseTemplateScript(o.lockingScript); if (t) template = t.fields
  }
  if (!file) {
    // Legacy MPT-FILE fallback (plaintext, unencrypted; authentic by being the on-chain tx itself).
    const leg = legacyFileFromTx(tx)
    if (leg) { const marker = leg.marker.toLowerCase(); return { fileName: leg.fields.fileName, mimeType: leg.fields.mimeType, bytes: leg.fields.fileBytes, encrypted: false, verified: true, legacy: marker, sha256: Utils.toHex(Hash.sha256(leg.fields.fileBytes)), rules: { legacy: marker } } }
    return null
  }
  const rules = template != null ? decodeTokenRules(template.tokenRules) : null
  const encrypted = rules?.isEncrypted ?? false
  let bytes = file.fileBytes
  let ciphertextOk = false
  if (encrypted) {
    ciphertextOk = template?.fileHash === Utils.toHex(Hash.sha256(file.fileBytes))
    if (template?.wrappedKey == null || template?.keySalt == null) throw new Error('encrypted collection is missing its wrapped key')
    const K = unwrapContentKey(template.wrappedKey, template.keySalt)
    if (K == null) throw new Error('could not unwrap the content key')
    bytes = decryptContent(bytes, K)
  }
  if (rules?.isCompressed) bytes = await decompress(bytes)
  const verified = encrypted ? ciphertextOk : (template?.fileHash === Utils.toHex(Hash.sha256(bytes)))
  return { fileName: file.fileName, mimeType: file.mimeType, bytes, encrypted, verified, sha256: Utils.toHex(Hash.sha256(bytes)), rules }
}

// Normalize a creator identity — a compressed pubkey (66-hex, 02/03) OR a base58 P2PKH address (what a wallet
// shows) — to { address, pubKeyHex|null }. Address alone suffices for discovery; pubkey also enables exact
// owner matching. Returns null if it's neither.
export function creatorIdentity (identity) {
  const id = String(identity || '').trim()
  if (/^0[23][0-9a-f]{64}$/i.test(id)) { const pk = PublicKey.fromString(id); return { address: pk.toAddress(), pubKeyHex: id.toLowerCase() } }
  if (/^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(id)) return { address: id, pubKeyHex: null }
  return null
}

async function fetchAddressHistory (address) {
  const r = await fetch(`https://api.whatsonchain.com/v1/bsv/main/address/${address}/history`)
  if (!r.ok) throw new Error(`address history lookup failed (${r.status})`)
  const j = await r.json()
  return (Array.isArray(j) ? j : (j.result || [])).map(h => h.tx_hash).filter(Boolean)
}

// Discover a creator's content atoms (collections) from their address/pubkey. Light metadata only — parses the
// on-chain file header (name + mime) WITHOUT decrypting the payload, so the content is fetched lazily when used.
// `known` (a Set of already-seen txids) lets a caller skip re-scanning; returns { address, atoms:[{txid,fileName,mimeType}] }.
export async function listCreatorAtoms (identity, { fetchHistory = fetchAddressHistory, fetchHex = fetchRawTxHex, known } = {}) {
  const who = creatorIdentity(identity)
  if (!who) throw new Error('enter a wallet address or a compressed public key')
  const txids = [...new Set(await fetchHistory(who.address))]
  const atoms = []
  for (const txid of txids) {
    if (known && known.has(txid)) continue
    try {
      const tx = Transaction.fromHex(await fetchHex(txid))
      let file = null
      for (const o of tx.outputs) { const f = parseFileScript(o.lockingScript); if (f) { file = f.fields; break } }
      if (!file) { const leg = legacyFileFromTx(tx); if (leg) file = { fileName: leg.fields.fileName, mimeType: leg.fields.mimeType } } // legacy MPT-FILE / P-FILE atoms too
      if (file) atoms.push({ txid, fileName: file.fileName, mimeType: file.mimeType }) // a collection carries content; editions/payments don't
    } catch { /* skip anything that isn't a parseable content collection */ }
  }
  return { address: who.address, atoms }
}
