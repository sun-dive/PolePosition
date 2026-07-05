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
import { buildEpub } from './epub.mjs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { unlink, readdir, rm } from 'node:fs/promises'

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
// Image-to-video model for "Animate cover". veo2 is confirmed-working but ~$0.50/sec; override FAL_VIDEO_MODEL
// in .env with a cheaper fast variant (Kling Turbo / Hailuo Fast / LTX) — endpoint id from fal.ai/explore.
const FAL_VIDEO_MODEL = process.env.FAL_VIDEO_MODEL || 'fal-ai/veo2/image-to-video'

const SYSTEM = 'You are a skilled co-author helping write an ebook. Write engaging, clear prose that matches the existing tone and style. Output ONLY the requested content as Markdown — no preamble, no explanations, no meta-commentary, no surrounding quotes.'

const IMG_PROMPT_SYSTEM = 'You are an expert prompt engineer for the fal.ai nano-banana (Google Gemini) text-to-image model, specializing in premium ebook covers and book illustrations. Given a short description, write ONE vivid, well-structured image prompt (3–6 sentences) covering subject and composition, art style, lighting, colour palette, and mood. For any words that must appear in the image, quote the EXACT text in double quotes and call for crisp, legible, well-kerned lettering. Aim for professional, marketable results. Output ONLY the final prompt — no preamble, no surrounding quotes, no commentary.'
const ANIM_PROMPT_SYSTEM = 'You write MOTION prompts for an image-to-video model that animates a STILL image into a SHORT, SEAMLESS LOOP for an eye-catching NFT. Given a description of the image, suggest gentle, tasteful motion that loops cleanly — drifting light particles, a soft glow that slowly pulses, faint camera drift, subtle shimmer on highlights, slow ambient background movement. Keep the motion SUBTLE and clearly loopable; the main subject should stay mostly still. AVOID distorting faces, hands, eyes, or text; avoid large, fast, or jarring movement. Write one or two sentences describing ONLY the motion. Output ONLY the motion prompt — no preamble, no quotes, no commentary.'

// Book Factory (stage 1: fast drafting). An outline architect + a chapter ghostwriter, both on the
// subscription via generate(). The `brief` is the seam a future niche-research step will fill in.
const OUTLINE_SYSTEM = 'You are a professional book architect and commissioning editor. Given a brief, design a coherent, sellable ebook. Output ONLY valid JSON (no markdown, no code fences, no commentary) of the exact form {"title": string, "subtitle": string, "chapters": [{"title": string, "synopsis": string}]}. The title must be specific and marketable — not generic. Each synopsis is 1–2 sentences stating what that chapter delivers to the reader. Order the chapters as a logical arc with no overlap or repetition.'
const CHAPTER_SYSTEM = 'You are a skilled ghostwriter drafting ONE complete chapter of an ebook. Write engaging, well-structured Markdown prose — use ## subheadings, short paragraphs, and lists where they genuinely help. Do NOT restate the chapter title as a heading (it is added separately). No preamble, no author note, no meta-commentary. Output ONLY the chapter prose as Markdown.'

// Tolerant JSON extraction — strips code fences and falls back to the outermost braces.
function parseJsonLoose (s) {
  if (!s) return null
  const t = s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  try { return JSON.parse(t) } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}')
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)) } catch {} }
  return null
}

async function generateOutline ({ brief, chapters, voice }) {
  const n = Math.min(Math.max(Number(chapters) || 8, 1), 30)
  const voiceNote = voice ? `\n\nVoice / tone: ${voice}.` : ''
  const raw = await generate(`Design an ebook from this brief. Aim for about ${n} chapters.${voiceNote}\n\nBrief:\n"""\n${String(brief).slice(0, 4000)}\n"""`, OUTLINE_SYSTEM)
  const j = parseJsonLoose(raw)
  if (!j || !Array.isArray(j.chapters) || !j.chapters.length) throw new Error('The model did not return a usable outline — try again or refine the brief.')
  return {
    title: String(j.title || '').trim(),
    subtitle: String(j.subtitle || '').trim(),
    chapters: j.chapters.slice(0, 40).map(c => ({ title: String(c.title || '').trim() || 'Untitled chapter', synopsis: String(c.synopsis || '').trim() }))
  }
}

async function draftChapter ({ title, author, voice, outline, index }) {
  const list = Array.isArray(outline) ? outline : []
  const i = Math.min(Math.max(Number(index) || 0, 0), list.length - 1)
  const ch = list[i] || { title: 'Chapter', synopsis: '' }
  const toc = list.map((c, k) => `${k + 1}. ${c.title}${c.synopsis ? ' — ' + c.synopsis : ''}`).join('\n')
  const voiceNote = voice ? `\nVoice / tone: ${voice}.` : ''
  const prompt = `Book: "${title || 'Untitled'}"${author ? ` by ${author}` : ''}.${voiceNote}\n\n` +
    `Full table of contents (for context — write only the requested chapter, don't reproduce the others):\n${toc}\n\n` +
    `Write Chapter ${i + 1}: "${ch.title}".\nWhat it must deliver: ${ch.synopsis || 'develop the topic clearly and engagingly.'}\n\n` +
    `Write the full chapter now — consistent with the book's arc, picking up logically from earlier chapters and not repeating them.`
  return generate(prompt, CHAPTER_SYSTEM)
}

function buildPrompt ({ mode, instruction, chapterText, selection, title, author, bookContext }) {
  const head = `Book: "${title || 'Untitled'}"${author ? ` by ${author}` : ''}.`
  // Optional: the rest of the book (other chapters) so new writing stays consistent with what's there
  // — e.g. a solution chapter that builds on the problem laid out earlier. Capped to bound the payload.
  const bookCtx = bookContext && bookContext.trim()
    ? `\n\nThe rest of the book so far (other chapters — for context & consistency; do NOT repeat or rewrite them):\n"""\n${bookContext.slice(-12000)}\n"""`
    : ''
  const ctx = chapterText && chapterText.trim() ? `\n\nThe chapter so far (for context, do not repeat it):\n"""\n${chapterText.slice(-6000)}\n"""` : ''
  switch (mode) {
    case 'continue': return `${head}${bookCtx}\n\nContinue this chapter naturally from where it ends, in the same voice.${instruction ? ` Direction: ${instruction}.` : ''}${ctx}`
    case 'rewrite': return `${head}${bookCtx}\n\nRewrite the passage below.${instruction ? ` Instruction: ${instruction}.` : ' Improve clarity, flow and vividness while keeping the meaning.'}\n\nPassage:\n"""\n${selection || ''}\n"""`
    case 'outline': return `${head}${bookCtx}\n\nCreate a clear, structured outline as a Markdown bullet list for: ${instruction || 'this book'}.`
    default: return `${head}${bookCtx}\n\nWrite the following${instruction ? `: ${instruction}` : ' section'}.${ctx}`
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
async function optimizeImagePrompt (description, kind, style, aspect) {
  const orient = aspect === '1:1' ? 'square' : aspect === '16:9' ? 'wide landscape' : 'portrait'
  const what = kind === 'cover' ? `a premium FRONT-COVER image (${orient} orientation)` : 'an in-book illustration'
  const styleNote = style ? `\n\nThe image WILL be rendered in this fixed house style — describe the subject and composition to suit it, and do NOT introduce a different style: ${style}` : ''
  const frames = { '16:9': 'a WIDE LANDSCAPE', '3:4': 'a TALL PORTRAIT', '1:1': 'a SQUARE', '2:3': 'a TALL PORTRAIT' }
  const aspectNote = aspect && frames[aspect] ? `\n\nCompose for ${frames[aspect]} frame: the illustration MUST fill the entire frame edge to edge — spread the subject and supporting elements across the whole frame. Do NOT place a small centred motif on an empty background.` : ''
  return generate(`Write ${what} prompt from this brief:\n\n"""${description}"""${styleNote}${aspectNote}`, IMG_PROMPT_SYSTEM)
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

// "Animate cover": send a still image to a fal IMAGE-TO-VIDEO model → get a short MP4 back (downloaded here).
async function falImageToVideo ({ image, prompt }) {
  const key = process.env.FAL_API_KEY
  if (!key) throw new Error('FAL_API_KEY isn’t set — add it to your local .env to animate.')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 300000) // video generation can take a minute or two
  let res
  try {
    res = await fetch('https://fal.run/' + FAL_VIDEO_MODEL, {
      method: 'POST',
      headers: { authorization: 'Key ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ image_url: image, prompt }),
      signal: ctrl.signal
    })
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'fal.ai timed out — video takes longer; try a faster/cheaper FAL_VIDEO_MODEL.' : ('fal.ai request failed: ' + e.message))
  } finally { clearTimeout(timer) }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const d = data && data.detail
    throw new Error('fal.ai: ' + (typeof d === 'string' ? d : d ? JSON.stringify(d) : ('error ' + res.status)))
  }
  const vurl = data && data.video && data.video.url
  if (!vurl) throw new Error('fal.ai returned no video — is FAL_VIDEO_MODEL an image-to-video model?')
  const vidRes = await fetch(vurl)
  return Buffer.from(await vidRes.arrayBuffer())
}

// Run ffmpeg with the given args; rejects with stderr tail on failure (or a clear message if ffmpeg is missing).
function runFfmpeg (args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', d => { err += d })
    p.on('error', e => reject(new Error('ffmpeg not found — install ffmpeg to convert the animation (' + e.message + ')')))
    p.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + err.slice(-400))))
  })
}

// MP4 → animated image data URL for an `<img>` cover: prefer animated WebP (small); fall back to GIF if this
// ffmpeg lacks libwebp. Kept short/low-res so it's small enough to embed + ride on-chain.
async function mp4ToAnimatedImage (mp4Buffer) {
  const base = join(tmpdir(), 'pp-anim-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
  const mp4 = base + '.mp4'
  await writeFile(mp4, mp4Buffer)
  const vf = 'fps=15,scale=512:-1:flags=lanczos'
  try {
    try {
      const webp = base + '.webp'
      await runFfmpeg(['-y', '-i', mp4, '-vcodec', 'libwebp', '-filter:v', vf, '-loop', '0', '-lossless', '0', '-q:v', '70', '-an', webp])
      const buf = await readFile(webp); await unlink(webp).catch(() => {})
      return { dataUrl: 'data:image/webp;base64,' + buf.toString('base64'), ext: 'webp' }
    } catch {
      const pal = base + '-pal.png', gif = base + '.gif'
      await runFfmpeg(['-y', '-i', mp4, '-vf', vf + ',palettegen', pal])
      await runFfmpeg(['-y', '-i', mp4, '-i', pal, '-lavfi', vf + '[x];[x][1:v]paletteuse', '-loop', '0', gif])
      const buf = await readFile(gif); await unlink(gif).catch(() => {}); await unlink(pal).catch(() => {})
      return { dataUrl: 'data:image/gif;base64,' + buf.toString('base64'), ext: 'gif' }
    }
  } finally { await unlink(mp4).catch(() => {}) }
}

// Generic command runner (magick/identify). Captures stdout when `capture` is true; rejects with stderr tail.
function runCmd (cmd, args, capture) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] })
    let out = '', err = ''
    if (capture) p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('error', e => reject(new Error(cmd + ' not found — install it (' + e.message + ')')))
    p.on('close', code => code === 0 ? resolve(out) : reject(new Error(cmd + ' failed: ' + err.slice(-300))))
  })
}

// Reduce an animated image to a fraction of its frame rate: keep every `stride`-th frame and multiply each
// frame's delay so it plays at the same real-time speed (stride 1 = unchanged, 2 = half fps, 3 = third). Uses
// ImageMagick (robust on animated WebP, unlike ffmpeg). Returns a new file path.
async function reduceFps (inputPath, stride) {
  if (stride <= 1) return inputPath
  const dir = inputPath + '.frames'
  await mkdir(dir, { recursive: true })
  await runCmd('magick', [inputPath, '-coalesce', join(dir, 'f-%05d.png')])
  let srcDelay = 7
  try { const d = parseInt((await runCmd('magick', ['identify', '-format', '%T\n', inputPath], true)).trim().split(/\s+/)[0], 10); if (d > 0) srcDelay = d } catch { /* default 7cs */ }
  const kept = (await readdir(dir)).filter(f => f.endsWith('.png')).sort().filter((_, i) => i % stride === 0).map(f => join(dir, f))
  const out = inputPath + '.reduced.webp'
  await runCmd('magick', ['-delay', String(srcDelay * stride), '-loop', '0', ...kept, out])
  await rm(dir, { recursive: true, force: true })
  return out
}

// Build a looping animated WebP from ordered steps [{ path, repeat }] at the chosen frame-rate stride.
// Concatenate full-rate (each clip repeated in order), then reduce the whole sequence once. Returns the path.
async function buildSequence (steps, stride) {
  const base = join(tmpdir(), 'pp-seq-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
  const args = []
  for (const s of steps) for (let i = 0; i < s.repeat; i++) args.push(s.path)
  const full = base + '-full.webp'
  await runCmd('magick', [...args, '-loop', '0', full])
  if (stride <= 1) return full
  const reduced = await reduceFps(full, stride)
  await unlink(full).catch(() => {})
  return reduced
}

function sendJson (res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
function readJson (req) {
  return new Promise((resolve, reject) => {
    let b = ''
    req.on('data', c => { b += c; if (b.length > 80e6) { reject(new Error('body too large')); req.destroy() } })
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}
// Read a raw binary request body (for audio uploads — base64 JSON would bloat a big WAV by a third).
function readRawBody (req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let len = 0
    req.on('data', c => { len += c.length; if (len > maxBytes) { reject(new Error('body too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
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
      const desc = String(body.description).trim()
      const prompt = body.kind === 'motion'
        ? await generate(`Write a subtle, seamless-loop motion prompt for this image:\n\n"""${desc}"""`, ANIM_PROMPT_SYSTEM)
        : await optimizeImagePrompt(desc, body.kind === 'cover' ? 'cover' : 'inline', typeof body.style === 'string' ? body.style.trim() : '', typeof body.aspect === 'string' ? body.aspect : '')
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

  // ── Animate a cover image (fal image-to-video → animated WebP/GIF for an <img> cover) ──
  if (url.pathname === '/api/animate' && req.method === 'POST') {
    let body
    try { body = await readJson(req) } catch { return sendJson(res, 400, { error: 'bad request body' }) }
    if (typeof body.image !== 'string' || !body.image.startsWith('data:')) return sendJson(res, 400, { error: 'Generate or open a cover image first.' })
    const prompt = (typeof body.prompt === 'string' && body.prompt.trim())
      ? body.prompt.trim()
      : 'Subtle, gentle ambient motion — slow drift, faint flicker — a calm, seamless loop. Keep the composition stable.'
    try {
      const mp4 = await falImageToVideo({ image: body.image, prompt })
      const out = await mp4ToAnimatedImage(mp4)
      return sendJson(res, 200, out)
    } catch (e) {
      return sendJson(res, 502, { error: e.message || 'animation failed' })
    }
  }

  // ── Sequence clips → a looping animated WebP (add clip ×N, add clip ×N, …, at a chosen frame rate) ──
  if (url.pathname === '/api/sequence' && req.method === 'POST') {
    let body
    try { body = await readJson(req) } catch { return sendJson(res, 400, { error: 'bad request body' }) }
    const stride = body.fps === 'third' ? 3 : body.fps === 'half' ? 2 : 1
    const rawSteps = Array.isArray(body.steps) ? body.steps : []
    const tmp = []
    try {
      const steps = []
      for (const s of rawSteps) {
        const m = typeof s?.image === 'string' && s.image.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i)
        if (!m) continue
        const p = join(tmpdir(), 'pp-clip-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.webp')
        await writeFile(p, Buffer.from(m[1], 'base64')); tmp.push(p)
        steps.push({ path: p, repeat: Math.min(50, Math.max(1, Math.floor(Number(s.repeat) || 1))) })
      }
      if (steps.length === 0) return sendJson(res, 400, { error: 'Add at least one clip.' })
      const outPath = await buildSequence(steps, stride); tmp.push(outPath)
      const buf = await readFile(outPath)
      // Frame count + total loop duration (sum of per-frame delays, centiseconds → seconds).
      let frames = 0, duration = 0
      try {
        const delays = (await runCmd('magick', ['identify', '-format', '%T\n', outPath], true)).trim().split('\n').filter(Boolean).map(n => parseInt(n, 10) || 0)
        frames = delays.length
        duration = delays.reduce((a, b) => a + b, 0) / 100
      } catch { /* leave 0 */ }
      return sendJson(res, 200, { dataUrl: 'data:image/webp;base64,' + buf.toString('base64'), size: buf.length, frames, duration })
    } catch (e) {
      return sendJson(res, 502, { error: e.message || 'sequence build failed' })
    } finally {
      for (const f of tmp) { await unlink(f).catch(() => {}); await unlink(f + '.reduced.webp').catch(() => {}); await rm(f + '.frames', { recursive: true, force: true }).catch(() => {}) }
    }
  }

  // ── WAV → FLAC (lossless, max compression) via the reference flac encoder ──
  if (url.pathname === '/api/flac' && req.method === 'POST') {
    const base = join(tmpdir(), 'pp-flac-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
    const inPath = base + '.wav', outPath = base + '.flac'
    try {
      const buf = await readRawBody(req, 600 * 1024 * 1024) // up to 600 MB WAV
      if (buf.length === 0) return sendJson(res, 400, { error: 'no audio uploaded' })
      await writeFile(inPath, buf)
      // --best = max (lossless) compression; --verify re-decodes to confirm bit-exact; -s silent; -f overwrite.
      await runCmd('flac', ['--best', '--verify', '-s', '-f', '-o', outPath, inPath])
      const flac = await readFile(outPath)
      res.writeHead(200, { 'content-type': 'audio/flac', 'content-disposition': 'attachment; filename="audio.flac"', 'x-orig-size': String(buf.length), 'x-flac-size': String(flac.length) })
      return res.end(flac)
    } catch (e) {
      return sendJson(res, 502, { error: 'FLAC encode failed: ' + (e.message || 'error') + ' (is the file a valid WAV?)' })
    } finally {
      await unlink(inPath).catch(() => {}); await unlink(outPath).catch(() => {})
    }
  }

  // ── Tag a FLAC (in-app Kid3): text tags + cover art by role (front/back/media) + lyrics, via metaflac ──
  // Body (JSON): { flac:<base64>, tags:{TITLE,ARTIST,ALBUM,DATE,COPYRIGHT,TRACKNUMBER,GENRE,…},
  //                lyrics:"<lrc/plain>", pictures:[{type:3|4|6, mime, width?, height?, data:<base64>}] }
  if (url.pathname === '/api/tag' && req.method === 'POST') {
    const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    const flacPath = join(tmpdir(), 'pp-tag-' + stamp + '.flac')
    const tmp = [] // extra temp files (lyrics + pictures) to clean up
    try {
      const raw = await readRawBody(req, 800 * 1024 * 1024)
      let job
      try { job = JSON.parse(raw.toString('utf8')) } catch { return sendJson(res, 400, { error: 'bad request body' }) }
      if (!job || typeof job.flac !== 'string' || !job.flac) return sendJson(res, 400, { error: 'no FLAC provided' })
      await writeFile(flacPath, Buffer.from(job.flac, 'base64'))

      const tags = (job.tags && typeof job.tags === 'object') ? job.tags : {}
      const clean = Object.entries(tags)
        .map(([k, v]) => [String(k).toUpperCase().replace(/[^A-Z0-9_]/g, ''), v])
        .filter(([k, v]) => k && v != null && String(v).trim() !== '')
      const hasLyrics = typeof job.lyrics === 'string' && job.lyrics.trim() !== ''
      const pics = Array.isArray(job.pictures) ? job.pictures.filter(p => p && typeof p.data === 'string' && p.data) : []

      // Pass 1 — remove what we're about to (re)write, so re-tagging never duplicates (leaves other tags intact).
      // metaflac forbids mixing "shorthand" ops (--remove-tag) with "major" ops (--remove) in one call → split.
      const rmTags = []
      for (const [k] of clean) rmTags.push('--remove-tag=' + k)
      if (hasLyrics) rmTags.push('--remove-tag=LYRICS')
      if (rmTags.length) await runCmd('metaflac', [...rmTags, flacPath])
      if (pics.length) await runCmd('metaflac', ['--remove', '--block-type=PICTURE', flacPath])

      // Pass 2 — write text tags, lyrics (from a temp file → multi-line safe), and pictures by type.
      const set = []
      for (const [k, v] of clean) set.push('--set-tag=' + k + '=' + String(v))
      if (hasLyrics) {
        const lp = join(tmpdir(), 'pp-lyr-' + stamp + '.txt'); tmp.push(lp)
        await writeFile(lp, job.lyrics)
        set.push('--set-tag-from-file=LYRICS=' + lp)
      }
      for (let i = 0; i < pics.length; i++) {
        const p = pics[i]
        const type = [3, 4, 6].includes(Number(p.type)) ? Number(p.type) : 3 // 3 front · 4 back · 6 media/disc
        const mime = (typeof p.mime === 'string' && p.mime.startsWith('image/')) ? p.mime : 'image/png'
        const ext = mime.split('/')[1].replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'png'
        const pp = join(tmpdir(), 'pp-pic-' + stamp + '-' + i + '.' + ext); tmp.push(pp)
        await writeFile(pp, Buffer.from(p.data, 'base64'))
        const w = Number(p.width) || 0, h = Number(p.height) || 0
        // spec: TYPE|MIME|DESCRIPTION|WIDTHxHEIGHTxDEPTH|FILE  (metaflac reads it as a single arg via spawn)
        set.push('--import-picture-from=' + `${type}|${mime}||${w && h ? `${w}x${h}x24` : '0x0x0'}|${pp}`)
      }
      if (!set.length) return sendJson(res, 400, { error: 'nothing to write — add text tags, cover art, or lyrics' })
      await runCmd('metaflac', [...set, flacPath])

      const out = await readFile(flacPath)
      res.writeHead(200, { 'content-type': 'audio/flac', 'content-disposition': 'attachment; filename="tagged.flac"', 'x-flac-size': String(out.length) })
      return res.end(out)
    } catch (e) {
      return sendJson(res, 502, { error: 'tagging failed: ' + (e.message || 'error') })
    } finally {
      await unlink(flacPath).catch(() => {})
      await Promise.all(tmp.map(f => unlink(f).catch(() => {})))
    }
  }

  // ── EPUB export (P4) ──
  if (url.pathname === '/api/epub' && req.method === 'POST') {
    let body
    try { body = await readJson(req) } catch { return sendJson(res, 400, { error: 'bad request body' }) }
    if (!body || !Array.isArray(body.chapters) || !body.chapters.length) return sendJson(res, 400, { error: 'no book to export' })
    try {
      const buf = await buildEpub(body, { artDir: ART_DIR, modified: new Date().toISOString() })
      res.writeHead(200, { 'content-type': 'application/epub+zip', 'content-disposition': 'attachment; filename="book.epub"' })
      return res.end(buf)
    } catch (e) {
      return sendJson(res, 500, { error: 'EPUB build failed: ' + e.message })
    }
  }

  // ── Book Factory: brief → outline (Claude Agent SDK, subscription) ──
  if (url.pathname === '/api/outline' && req.method === 'POST') {
    let body
    try { body = await readJson(req) } catch { return sendJson(res, 400, { error: 'bad request body' }) }
    if (!body.brief || !String(body.brief).trim()) return sendJson(res, 400, { error: 'Describe the book / niche first.' })
    try {
      const outline = await generateOutline({ brief: String(body.brief).trim(), chapters: body.chapters, voice: typeof body.voice === 'string' ? body.voice.trim() : '' })
      return sendJson(res, 200, outline)
    } catch (e) {
      return sendJson(res, 502, { error: e.message || 'outline failed' })
    }
  }

  // ── Book Factory: outline + index → one drafted chapter (Claude Agent SDK, subscription) ──
  if (url.pathname === '/api/draft-chapter' && req.method === 'POST') {
    let body
    try { body = await readJson(req) } catch { return sendJson(res, 400, { error: 'bad request body' }) }
    if (!Array.isArray(body.outline) || !body.outline.length) return sendJson(res, 400, { error: 'no outline to draft from' })
    try {
      const text = await draftChapter({ title: body.title, author: body.author, voice: typeof body.voice === 'string' ? body.voice.trim() : '', outline: body.outline, index: body.index })
      if (!text) return sendJson(res, 502, { error: 'The model returned no text — try again.' })
      return sendJson(res, 200, { text })
    } catch (e) {
      return sendJson(res, 502, { error: e.message || 'chapter draft failed' })
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
