// Pole Position — local-first NFT content-creation studio.
// Serves the editor (public/) and proxies AI calls. Writing runs on the Claude Agent SDK using YOUR
// Claude subscription (the creds under ~/.claude) — NOT a pay-as-you-go API key.
//   P2: POST /api/write → Claude (Agent SDK, subscription).   P3 will add /api/image → fal.ai.
// Setup:  npm install   then   node server.mjs   →   http://localhost:4321
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, 'public')
const PORT = Number(process.env.PORT) || 4321
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' }

// Load .env (KEY=VALUE) for non-Claude keys (e.g. FAL_API_KEY in P3). Real environment wins.
function loadEnv () {
  const p = join(HERE, '.env')
  if (!existsSync(p)) return
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
loadEnv()

// HARD GUARD: never let an Anthropic API key reach the SDK — it would override the subscription and bill
// per-token. If one is set (shell or .env), drop it so writing always bills against your Claude plan.
if (process.env.ANTHROPIC_API_KEY) {
  console.warn('  ⚠️  ANTHROPIC_API_KEY was set — IGNORING it so writing bills to your Claude subscription, not per-token.')
  delete process.env.ANTHROPIC_API_KEY
}
const MODEL = process.env.CLAUDE_MODEL || undefined // optional, e.g. claude-opus-4-8; default = subscription default

const SYSTEM = 'You are a skilled co-author helping write an ebook. Write engaging, clear prose that matches the existing tone and style. Output ONLY the requested content as Markdown — no preamble, no explanations, no meta-commentary, no surrounding quotes.'

function buildPrompt ({ mode, instruction, chapterText, selection, title, author }) {
  const head = `Book: "${title || 'Untitled'}"${author ? ` by ${author}` : ''}.`
  const ctx = chapterText && chapterText.trim() ? `\n\nThe chapter so far (for context, do not repeat it):\n"""\n${chapterText.slice(-6000)}\n"""` : ''
  switch (mode) {
    case 'continue': return `${head}\n\nContinue this chapter naturally from where it ends, in the same voice.${instruction ? ` Direction: ${instruction}.` : ''}${ctx}`
    case 'rewrite': return `${head}\n\nRewrite the passage below.${instruction ? ` Instruction: ${instruction}.` : ' Improve clarity, flow and vividness while keeping the meaning.'}\n\nPassage:\n"""\n${selection || ''}\n"""`
    case 'outline': return `${head}\n\nCreate a clear, structured outline as a Markdown bullet list for: ${instruction || 'this book'}.`
    default: return `${head}\n\nWrite the following${instruction ? `: ${instruction}` : ' section'}.${ctx}`
  }
}

// Generate text via the Agent SDK (single turn, no tools, no project settings — pure writing).
async function generate (prompt) {
  const options = {
    maxTurns: 1,
    permissionMode: 'bypassPermissions',
    disallowedTools: ['Bash', 'Edit', 'Write', 'Read', 'WebFetch', 'WebSearch', 'Glob', 'Grep', 'TodoWrite', 'NotebookEdit', 'Task'],
    settingSources: [], // don't load the user's CLAUDE.md/project settings into the writing context
    systemPrompt: SYSTEM,
    ...(MODEL ? { model: MODEL } : {})
  }
  let text = '', failure = null
  for await (const m of query({ prompt, options })) {
    if (m.type === 'result') {
      if (m.subtype === 'success' && !m.is_error) text = m.result || text
      else failure = m.subtype || 'error'
    } else if (m.type === 'assistant' && !text) {
      const c = m.message?.content ?? []
      const t = c.filter(b => b.type === 'text').map(b => b.text).join('')
      if (t) text = t
    }
  }
  if (!text && failure) throw new Error(friendlyError(failure))
  return text.trim()
}
function friendlyError (code) {
  if (/auth/i.test(code)) return 'Not signed in to Claude — run the Claude app / `claude login` so ~/.claude has valid credentials.'
  if (/rate|limit/i.test(code)) return 'Hit your Claude plan rate limit — wait a moment and retry.'
  if (/billing/i.test(code)) return 'Claude billing issue on your plan — check your subscription status.'
  return 'The model could not complete the request (' + code + ').'
}

function sendJson (res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
function readJson (req) {
  return new Promise((resolve, reject) => {
    let b = ''
    req.on('data', c => { b += c; if (b.length > 2e6) { reject(new Error('body too large')); req.destroy() } })
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

  // ── AI writing (Claude Agent SDK, subscription) ──
  if (url.pathname === '/api/write' && req.method === 'POST') {
    let body
    try { body = await readJson(req) } catch { return sendJson(res, 400, { error: 'bad request body' }) }
    if (body.mode === 'rewrite' && !(body.selection || '').trim()) return sendJson(res, 400, { error: 'Select some text to rewrite first.' })
    try {
      const text = await generate(buildPrompt(body))
      if (!text) return sendJson(res, 502, { error: 'The model returned no text — try again.' })
      return sendJson(res, 200, { text })
    } catch (e) {
      return sendJson(res, 502, { error: e.message || 'AI request failed' })
    }
  }

  if (url.pathname.startsWith('/api/')) return sendJson(res, 501, { error: 'not implemented yet', endpoint: url.pathname })

  // ── Static files (path-traversal guarded) ──
  const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname)
  if (rel.includes('..')) { res.writeHead(403); res.end('Forbidden'); return }
  try {
    const data = await readFile(join(ROOT, rel))
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404); res.end('Not found')
  }
})

server.listen(PORT, () => {
  console.log(`\n  🏁 Pole Position → http://localhost:${PORT}`)
  console.log(`     writing: Claude Agent SDK on your subscription (no API key) · model: ${MODEL || 'plan default'}\n`)
})
