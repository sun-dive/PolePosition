// Import-from-mint: fetch a collection tx by txid and recover its (decrypted, decompressed) content,
// reusing PharLap's PROVEN on-chain decoders (vendored alongside). Mirrors PharLap
// src/app.ts:fetchCollectionContent — Tier-1 keyless unwrap, self-verifying against the on-chain commitment.
//
// The .ts decoders are vendored copies of PharLap/src/{tokenCodec,contentCrypto,compress,pushDrop}.ts —
// keep them in sync when PharLap's on-chain format changes.
import { Transaction, Utils, Hash, PublicKey } from '@bsv/sdk'
import { parseFileScript, parseTemplateScript, decodeTokenRules } from './tokenCodec.ts'
import { unwrapContentKey, decryptContent } from './contentCrypto.ts'
import { decompress } from './compress.ts'

// ── Legacy plaintext file format (the original on-chain provenance mints) ──
// Encoding: OP_FALSE OP_RETURN, then pushdata fields [<marker>, <mime>, <fileName>, <data…>] where the marker
// is "MPT-FILE" (Merkle-Proof-Token generation) or "P-FILE" (the P-protocol generation) — plaintext,
// unencrypted, self-authenticating by being the on-chain tx itself. Superseded by the covenant/PushDrop
// format, but still resolvable so an origin provenance mint can be reused in a BMF composition.
const LEGACY_FILE_MARKERS = new Set(['MPT-FILE', 'P-FILE'])
function readPush (bytes, i) {
  const op = bytes[i++]
  let len
  if (op >= 0x01 && op <= 0x4b) len = op
  else if (op === 0x4c) len = bytes[i++]
  else if (op === 0x4d) { len = bytes[i] | (bytes[i + 1] << 8); i += 2 }
  else if (op === 0x4e) { len = bytes[i] + bytes[i + 1] * 0x100 + bytes[i + 2] * 0x10000 + bytes[i + 3] * 0x1000000; i += 4 }
  else return null // not a pushdata opcode
  if (i + len > bytes.length) return null
  return { data: bytes.slice(i, i + len), next: i + len }
}
function decodeMptFile (scriptBytes) {
  let i = 0
  if (scriptBytes[i] === 0x00) i++ // optional OP_FALSE
  if (scriptBytes[i] !== 0x6a) return null // OP_RETURN
  i++
  const fields = []
  while (i < scriptBytes.length) { const r = readPush(scriptBytes, i); if (!r) break; fields.push(r.data); i = r.next }
  if (fields.length < 4 || !LEGACY_FILE_MARKERS.has(Utils.toUTF8(fields[0]))) return null
  const bytes = []
  for (const f of fields.slice(3)) for (const b of f) bytes.push(b) // concat remaining pushes = the file
  return { fileName: Utils.toUTF8(fields[2]), mimeType: Utils.toUTF8(fields[1]), bytes, marker: Utils.toUTF8(fields[0]).toLowerCase() }
}
// Find an MPT-FILE payload across a tx's outputs (null if none).
function mptFileFromTx (tx) {
  for (const o of tx.outputs) {
    const mpt = decodeMptFile(o.lockingScript.toBinary())
    if (mpt) return mpt
  }
  return null
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
    const mpt = mptFileFromTx(tx)
    if (mpt) return { fileName: mpt.fileName, mimeType: mpt.mimeType, bytes: mpt.bytes, encrypted: false, verified: true, legacy: mpt.marker, sha256: Utils.toHex(Hash.sha256(mpt.bytes)), rules: { legacy: mpt.marker } }
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
      if (!file) { const mpt = mptFileFromTx(tx); if (mpt) file = { fileName: mpt.fileName, mimeType: mpt.mimeType } } // legacy MPT-FILE atoms too
      if (file) atoms.push({ txid, fileName: file.fileName, mimeType: file.mimeType }) // a collection carries content; editions/payments don't
    } catch { /* skip anything that isn't a parseable content collection */ }
  }
  return { address: who.address, atoms }
}
