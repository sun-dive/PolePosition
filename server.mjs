// Pole Position — local-first NFT content-creation studio.
// Serves the editor (public/) and proxies AI calls. Writing runs on the Claude Agent SDK using YOUR
// Claude subscription (the creds under ~/.claude) — NOT a pay-as-you-go API key.
//   P2: POST /api/write → Claude (Agent SDK, subscription).   P3 will add /api/image → fal.ai.
// Setup:  npm install   then   node server.mjs   →   http://localhost:4321
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, 'public')
const ART_DIR = join(ROOT, 'art') // saved inline book art (served as /art/<file>)
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
const FAL_MODEL = process.env.FAL_MODEL || 'fal-ai/nano-banana' // P3 image model (nano-banana = great at text; override via .env)

const SYSTEM = 'You are a skilled co-author helping write an ebook. Write engaging, clear prose that matches the existing tone and style. Output ONLY the requested content as Markdown — no preamble, no explanations, no meta-commentary, no surrounding quotes.'

const IMG_PROMPT_SYSTEM = 'You are an expert prompt engineer for the fal.ai nano-banana (Google Gemini) text-to-image model, specializing in premium ebook covers and book illustrations. Given a short description, write ONE vivid, well-structured image prompt (3–6 sentences) covering subject and composition, art style, lighting, colour palette, and mood. For any words that must appear in the image, quote the EXACT text in double quotes and call for crisp, legible, well-kerned lettering. Aim for professional, marketable results. Output ONLY the final prompt — no preamble, no surrounding quotes, no commentary.'

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
async function generate (prompt, system = SYSTEM) {
  const options = {
    maxTurns: 1,
    permissionMode: 'bypassPermissions',
    disallowedTools: ['Bash', 'Edit', 'Write', 'Read', 'WebFetch', 'WebSearch', 'Glob', 'Grep', 'TodoWrite', 'NotebookEdit', 'Task'],
    settingSources: [], // don't load the user's CLAUDE.md/project settings into the writing context
    systemPrompt: system,
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

// Turn a simple description into a rich image prompt via Claude (subscription) — the masterclass workflow.
async function optimizeImagePrompt (description, kind) {
  const what = kind === 'cover' ? 'a premium ebook FRONT-COVER image (portrait orientation)' : 'an in-book illustration'
  return generate(`Write ${what} prompt from this brief:\n\n"""${description}"""`, IMG_PROMPT_SYSTEM)
}

// Generate an image via fal.ai (P3). Uses FAL_API_KEY from .env — never logged. Returns a data: URL so the
// browser can show + save it without depending on fal's (time-limited) CDN link. Model-aware: nano-banana
// (Gemini) takes aspect_ratio + is strong at text; flux-style models take image_size.
async function falImage ({ prompt, model, aspectRatio, width, height, imageUrls }) {
  const key = process.env.FAL_API_KEY
  if (!key) throw new Error('FAL_API_KEY isn’t set — add it to your local .env to generate images.')
  const editing = Array.isArray(imageUrls) && imageUrls.length > 0
  const m = model || (editing ? 'fal-ai/nano-banana/edit' : FAL_MODEL)
  const input = m.includes('nano-banana')
    ? { prompt, num_images: 1, output_format: 'png',
        ...(editing
          ? { image_urls: imageUrls, ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}) } // edit: preserve source framing unless explicitly told otherwise
          : { aspect_ratio: aspectRatio || '2:3' }) }
    : { prompt, image_size: { width: width || 1024, height: height || 1536 }, num_images: 1, enable_safety_checker: true }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 180000)
  let res
  try {
    res = await fetch('https://fal.run/' + m, {
      method: 'POST',
      headers: { authorization: 'Key ' + key, 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: ctrl.signal
    })
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'fal.ai timed out — try again.' : ('fal.ai request failed: ' + e.message))
  } finally { clearTimeout(timer) }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const d = data && data.detail
    throw new Error('fal.ai: ' + (typeof d === 'string' ? d : d ? JSON.stringify(d) : ('error ' + res.status)))
  }
  const img = data && data.images && data.images[0]
  if (!img || !img.url) throw new Error('fal.ai returned no image.')
  const imgRes = await fetch(img.url)
  const buf = Buffer.from(await imgRes.arrayBuffer())
  const ct = img.content_type || imgRes.headers.get('content-type') || 'image/jpeg'
  return 'data:' + ct + ';base64,' + buf.toString('base64')
}

function sendJson (res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
function readJson (req) {
  return new Promise((resolve, reject) => {
    let b = ''
    req.on('data', c => { b += c; if (b.length > 12e6) { reject(new Error('body too large')); req.destroy() } })
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

  // ── Optimize a simple description into a rich image prompt (Claude Agent SDK, subscription) ──
  if (url.pathname === '/api/image-prompt' && req.method === 'POST') {
    let body
    try { body = await readJson(req) } catch { return sendJson(res, 400, { error: 'bad request body' }) }
    if (!body.description || !String(body.description).trim()) return sendJson(res, 400, { error: 'Describe the image first.' })
    try {
      const prompt = await optimizeImagePrompt(String(body.description).trim(), body.kind === 'cover' ? 'cover' : 'inline')
      if (!prompt) return sendJson(res, 502, { error: 'No prompt returned — try again.' })
      return sendJson(res, 200, { prompt })
    } catch (e) {
      return sendJson(res, 502, { error: e.message || 'prompt optimization failed' })
    }
  }

  // ── Save a generated image to disk (public/art) → return its URL, for inline book art ──
  if (url.pathname === '/api/save-image' && req.method === 'POST') {
    let body
    try { body = await readJson(req) } catch { return sendJson(res, 400, { error: 'bad request body' }) }
    const m = typeof body.dataUrl === 'string' && body.dataUrl.match(/^data:image\/([a-z0-9.+-]+);base64,(.+)$/i)
    if (!m) return sendJson(res, 400, { error: 'no image data' })
    const ext = m[1].toLowerCase().replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'png'
    try {
      await mkdir(ART_DIR, { recursive: true })
      const name = 'art-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext
      await writeFile(join(ART_DIR, name), Buffer.from(m[2], 'base64'))
      return sendJson(res, 200, { url: 'art/' + name })
    } catch (e) {
      return sendJson(res, 502, { error: 'could not save image: ' + e.message })
    }
  }

  // ── Image generation (fal.ai, P3) ──
  if (url.pathname === '/api/image' && req.method === 'POST') {
    let body
    try { body = await readJson(req) } catch { return sendJson(res, 400, { error: 'bad request body' }) }
    if (!body.prompt || !String(body.prompt).trim()) return sendJson(res, 400, { error: 'Describe the image first.' })
    const width = Math.min(Math.max(Number(body.width) || 1024, 256), 1536)
    const height = Math.min(Math.max(Number(body.height) || 1536, 256), 1536)
    const imageUrls = (typeof body.image === 'string' && body.image.startsWith('data:')) ? [body.image] : undefined
    try {
      const dataUrl = await falImage({ prompt: String(body.prompt).trim(), model: body.model, aspectRatio: body.aspectRatio, width, height, imageUrls })
      return sendJson(res, 200, { dataUrl })
    } catch (e) {
      return sendJson(res, 502, { error: e.message || 'image generation failed' })
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
