// Import-from-mint: fetch a collection tx by txid and recover its (decrypted, decompressed) content,
// reusing PharLap's PROVEN on-chain decoders (vendored alongside). Mirrors PharLap
// src/app.ts:fetchCollectionContent — Tier-1 keyless unwrap, self-verifying against the on-chain commitment.
//
// The .ts decoders are vendored copies of PharLap/src/{tokenCodec,contentCrypto,compress,pushDrop}.ts —
// keep them in sync when PharLap's on-chain format changes.
import { Transaction, Utils, Hash } from '@bsv/sdk'
import { parseFileScript, parseTemplateScript, decodeTokenRules } from './tokenCodec.ts'
import { unwrapContentKey, decryptContent } from './contentCrypto.ts'
import { decompress } from './compress.ts'

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
  if (!file) return null
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
