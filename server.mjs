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
import { tmpdir, homedir } from 'node:os'
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

// ── Projects ─────────────────────────────────────────────────────────────────────────────────────
// A project is deliberately tiny for now: just a name + a "masters" folder. The masters folder is where
// EVERY fal.ai original (full-res images + videos) is archived at generation time, even if never used in
// the final piece — so the highest-resolution source is always kept and downscaling is a later, deliberate
// choice (native-res YouTube export vs a byte-efficient on-chain mint). Registry lives outside the repo.
const PP_DIR = join(homedir(), '.poleposition')
const PROJECTS_FILE = join(PP_DIR, 'projects.json')
let CURRENT = null // { name, mastersDir }
let RECENT = []    // [{ name, mastersDir, opened }]  most-recent first
let LAST_RENDER_DIR = '' // last folder a music-video render was saved to — reused as the default next time
const slug = (s, n = 48) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, n)
const expandTilde = p => { p = String(p || '').trim(); return p.startsWith('~') ? join(homedir(), p.slice(1).replace(/^[/\\]+/, '')) : p }
function loadProjectsState () {
  try {
    if (!existsSync(PROJECTS_FILE)) return
    const s = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'))
    RECENT = Array.isArray(s.recent) ? s.recent.filter(p => p && p.name && p.mastersDir) : []
    if (s.current) { const c = RECENT.find(p => p.name === s.current); if (c) CURRENT = { name: c.name, mastersDir: c.mastersDir, renderDir: c.renderDir || '' } }
    if (typeof s.lastRenderDir === 'string') LAST_RENDER_DIR = s.lastRenderDir
  } catch (e) { console.warn('  ⚠️  projects.json unreadable — starting fresh:', e.message) }
}
async function persistProjects () {
  try { await mkdir(PP_DIR, { recursive: true }); await writeFile(PROJECTS_FILE, JSON.stringify({ current: CURRENT?.name || null, recent: RECENT, lastRenderDir: LAST_RENDER_DIR }, null, 2)) }
  catch (e) { console.warn('  ⚠️  could not save projects.json:', e.message) }
}
// Expand a leading ~ and fall back to ~/PolePosition/<slug>-masters when no folder is given.
function resolveMastersDir (name, dir) {
  dir = expandTilde(dir)
  if (!dir) dir = join(homedir(), 'PolePosition', (slug(name) || 'project') + '-masters')
  return dir
}
// Archive a fal.ai original into the current project's masters folder. No-op (returns null) with no project.
async function saveMaster (kind, buf, ext, hint) {
  if (!CURRENT?.mastersDir) return null
  try {
    await mkdir(CURRENT.mastersDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
    const h = slug(hint, 32)
    const name = kind + '-' + ts + (h ? '-' + h : '') + '.' + ext
    const p = join(CURRENT.mastersDir, name)
    await writeFile(p, buf)
    return p
  } catch (e) { console.warn('  ⚠️  could not save master:', e.message); return null }
}
loadProjectsState()

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
const ANIM_PROMPT_SYSTEM = 'You write MOTION prompts for an image-to-video model that animates a STILL image into a SHORT, SEAMLESS LOOP for an eye-catching NFT. Given a description of the image, suggest gentle, tasteful motion that loops cleanly, choosing whichever fits best: (1) ACTION — if the image clearly shows something in progress (a character writing, text in a speech bubble, pouring, typing, gesturing), animate THAT action subtly, e.g. the pen moves and the words write on stroke by stroke; this is often the most compelling loop. (2) AMBIENT — otherwise, drifting light particles, a soft glow that slowly pulses, faint camera drift, or subtle shimmer on highlights. Keep motion SUBTLE and clearly loopable; keep faces, hands, and eyes stable and undistorted; avoid large, fast, or jarring movement. Write one or two sentences describing ONLY the motion. Output ONLY the motion prompt — no preamble, no quotes, no commentary.'

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
  const ext = /png/.test(ct) ? 'png' : /webp/.test(ct) ? 'webp' : 'jpg'
  const master = await saveMaster('img', buf, ext, prompt) // archive the full-res original, used or not
  return { dataUrl: 'data:' + ct + ';base64,' + buf.toString('base64'), master }
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
  const buf = Buffer.from(await vidRes.arrayBuffer())
  const master = await saveMaster('vid', buf, 'mp4', prompt) // archive the full-res MP4 — the true master
  return { buffer: buf, master }
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

// MP4 → animated image data URL for an `<img>` preview: prefer animated WebP; fall back to GIF if this ffmpeg
// lacks libwebp. NO forced downscale — native resolution + frame rate are kept (the full-res MP4 is archived
// as the master, and any shrink is a deliberate later step: Video→WebP, per-clip fps, or an export size).
async function mp4ToAnimatedImage (mp4Buffer) {
  const base = join(tmpdir(), 'pp-anim-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
  const mp4 = base + '.mp4'
  await writeFile(mp4, mp4Buffer)
  try {
    try {
      const webp = base + '.webp'
      await runFfmpeg(['-y', '-i', mp4, '-vcodec', 'libwebp', '-loop', '0', '-lossless', '0', '-q:v', '80', '-an', webp])
      const buf = await readFile(webp); await unlink(webp).catch(() => {})
      return { dataUrl: 'data:image/webp;base64,' + buf.toString('base64'), ext: 'webp' }
    } catch {
      const pal = base + '-pal.png', gif = base + '.gif'
      await runFfmpeg(['-y', '-i', mp4, '-vf', 'palettegen', pal])
      await runFfmpeg(['-y', '-i', mp4, '-i', pal, '-lavfi', 'paletteuse', '-loop', '0', gif])
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

// Reduce an animated image to a fraction of its frame rate: keep every `stride`-th frame and stretch each
// kept frame's duration so it plays at the same real-time speed (stride 1 = unchanged, 2 = half fps, 3 = third).
// Returns a new file path.
//
// PREFERRED path = LOSSLESS remux via webpmux: extract each kept frame's ORIGINAL encoded bitstream and just
// re-time it (no decode, no re-encode → zero quality loss). Only valid when every frame is full-canvas
// (offset 0,0, full size) — true for video/Kling clips. Falls back to the ImageMagick coalesce+re-encode path
// for partial-frame inputs or if webpmux is unavailable.
async function reduceFps (inputPath, stride) {
  if (stride <= 1) return inputPath
  try {
    const info = await runCmd('webpmux', ['-info', inputPath], true)
    const cm = info.match(/Canvas size:\s*(\d+)\s*x\s*(\d+)/i)
    const W = cm ? +cm[1] : 0, H = cm ? +cm[2] : 0
    const rows = []
    for (const line of info.split('\n')) {
      const m = line.trim().match(/^(\d+):\s+(\d+)\s+(\d+)\s+\S+\s+(\d+)\s+(\d+)\s+(\d+)\s/)
      if (m) rows.push({ w: +m[2], h: +m[3], x: +m[4], y: +m[5], dur: +m[6] }) // dur = ms
    }
    // Only remux when every frame is full-canvas (dropping a partial/blended frame would corrupt the picture).
    if (rows.length > 1 && W > 0 && rows.every(r => r.x === 0 && r.y === 0 && r.w === W && r.h === H)) {
      const dir = inputPath + '.wm'
      await mkdir(dir, { recursive: true })
      const frameArgs = []
      for (let i = 0; i < rows.length; i += stride) {
        let dur = 0
        for (let j = i; j < Math.min(i + stride, rows.length); j++) dur += rows[j].dur // absorb dropped frames' time
        const fp = join(dir, `f${String(i).padStart(5, '0')}.webp`)
        await runCmd('webpmux', ['-get', 'frame', String(i + 1), inputPath, '-o', fp]) // webpmux frames are 1-indexed
        frameArgs.push('-frame', fp, `+${dur || 40}+0+0+0-b`) // full-canvas, no offset, dispose none, no-blend
      }
      const out = inputPath + '.reduced.webp'
      await runCmd('webpmux', [...frameArgs, '-loop', '0', '-o', out])
      await rm(dir, { recursive: true, force: true })
      return out
    }
  } catch { /* webpmux missing or unexpected output → fall through to the ImageMagick path below */ }
  // Fallback: coalesce → re-encode (always correct, incl. partial-frame inputs, but lossy).
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
// Losslessly stitch clips into ONE variable-frame-rate WebP: for each clip keep every (its OWN) stride-th
// frame's ORIGINAL bitstream — re-timed to absorb the dropped frames — and append it in order/repeat. No
// decode/re-encode anywhere, and each clip keeps its own optimal frame rate in the single output. Requires
// every clip to be a same-size, full-canvas WebP; returns null otherwise (caller falls back).
async function losslessSequence (steps, outPath) {
  let W = 0, H = 0
  const clips = []
  for (const s of steps) {
    let info
    try { info = await runCmd('webpmux', ['-info', s.path], true) } catch { return null }
    const cm = info.match(/Canvas size:\s*(\d+)\s*x\s*(\d+)/i); if (!cm) return null
    const w = +cm[1], h = +cm[2]
    if (W === 0) { W = w; H = h } else if (w !== W || h !== H) return null // sizes must match to share one canvas
    const durs = []
    for (const line of info.split('\n')) {
      const m = line.trim().match(/^(\d+):\s+(\d+)\s+(\d+)\s+\S+\s+(\d+)\s+(\d+)\s+(\d+)\s/)
      if (m) { if (+m[4] !== 0 || +m[5] !== 0 || +m[2] !== w || +m[3] !== h) return null; durs.push(+m[6]) }
    }
    if (durs.length === 0) return null
    clips.push({ path: s.path, durs, stride: Math.max(1, s.stride | 0), repeat: Math.max(1, s.repeat | 0) })
  }
  const dir = outPath + '.frames'; await mkdir(dir, { recursive: true })
  const frameArgs = []; let ci = 0
  for (const c of clips) {
    const kept = [] // extract this clip's kept frames ONCE, re-time each to absorb the dropped frames' duration
    for (let i = 0; i < c.durs.length; i += c.stride) {
      let dur = 0; for (let j = i; j < Math.min(i + c.stride, c.durs.length); j++) dur += c.durs[j]
      const fp = join(dir, `c${ci}_${String(i).padStart(5, '0')}.webp`)
      await runCmd('webpmux', ['-get', 'frame', String(i + 1), c.path, '-o', fp])
      kept.push({ fp, dur: dur || 40 })
    }
    ci++
    for (let rep = 0; rep < c.repeat; rep++) for (const kf of kept) frameArgs.push('-frame', kf.fp, `+${kf.dur}+0+0+0-b`)
  }
  await runCmd('webpmux', [...frameArgs, '-loop', '0', '-o', outPath])
  await rm(dir, { recursive: true, force: true })
  return outPath
}

// Read an animated WebP's canvas size (via webpmux) → { w, h } or null.
async function clipSize (p) {
  try { const info = await runCmd('webpmux', ['-info', p], true); const m = info.match(/Canvas size:\s*(\d+)\s*x\s*(\d+)/i); return m ? { w: +m[1], h: +m[2] } : null } catch { return null }
}

// Reduce a clip to `stride` and (if needed) fit it to `target` size, returning a same-size WebP path. Lossless
// webpmux remux when the clip is already at target size; ImageMagick coalesce + cover-crop + frame-drop
// otherwise (scaling forces a re-encode). Newly-created temp files are pushed to `created` for cleanup.
async function reduceAndFit (inPath, stride, target, created) {
  const st = Math.max(1, stride | 0)
  const sz = await clipSize(inPath)
  if (sz && sz.w === target.w && sz.h === target.h) {
    const r = await reduceFps(inPath, st); if (r !== inPath) created.push(r); return r
  }
  const out = inPath + '.norm.webp'; created.push(out)
  const dir = inPath + '.normf'; await mkdir(dir, { recursive: true })
  await runCmd('magick', [inPath, '-coalesce', '-resize', `${target.w}x${target.h}^`, '-gravity', 'center', '-extent', `${target.w}x${target.h}`, join(dir, 'f-%05d.png')])
  let srcDelay = 7
  try { const d = parseInt((await runCmd('magick', ['identify', '-format', '%T\n', inPath], true)).trim().split(/\s+/)[0], 10); if (d > 0) srcDelay = d } catch { /* default */ }
  const kept = (await readdir(dir)).filter(f => f.endsWith('.png')).sort().filter((_, i) => i % st === 0).map(f => join(dir, f))
  await runCmd('magick', ['-delay', String(srcDelay * st), '-loop', '0', ...kept, out])
  await rm(dir, { recursive: true, force: true })
  return out
}

// Build a looping WebP from ordered steps [{ path, repeat, stride }] — each clip at its OWN target frame rate
// (variable-frame-rate output). Same-size WebPs → fully-lossless remux; mixed sizes → fit each clip to the
// first clip's canvas (re-encoding only the ones that actually need scaling), then lossless-stitch.
async function buildSequence (steps) {
  const base = join(tmpdir(), 'pp-seq-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
  // 1) Fully-lossless VFR remux (all clips already the same size + full-frame).
  const out = base + '-seq.webp'
  try { if (await losslessSequence(steps, out)) return out } catch { /* fall through */ }
  await unlink(out).catch(() => {})
  // 2) Mixed sizes: fit every clip to the LARGEST clip's canvas (highest res wins — downscale only at
  //    final export), each at its own stride, then lossless-stitch. Clips already at that size stay lossless.
  const created = []
  try {
    let target = null
    for (const s of steps) { const sz = await clipSize(s.path); if (sz && (!target || sz.w * sz.h > target.w * target.h)) target = sz }
    if (target) {
      const normSteps = []
      for (const s of steps) normSteps.push({ path: await reduceAndFit(s.path, s.stride, target, created), repeat: Math.max(1, s.repeat | 0), stride: 1 })
      const out2 = base + '-seqn.webp'
      if (await losslessSequence(normSteps, out2)) { for (const f of created) await unlink(f).catch(() => {}); return out2 }
      await unlink(out2).catch(() => {})
    }
  } catch { /* fall through */ }
  for (const f of created) await unlink(f).catch(() => {})
  // 3) Last resort: crude ImageMagick concat (may crop truly-incompatible inputs).
  const args = []
  for (const s of steps) for (let i = 0; i < Math.max(1, s.repeat | 0); i++) args.push(s.path)
  const stride = Math.max(1, steps[0]?.stride | 0)
  if (args.length === 1) return await reduceFps(args[0], stride)
  const full = base + '-full.webp'
  await runCmd('magick', [...args, '-loop', '0', full])
  if (stride <= 1) return full
  const reduced = await reduceFps(full, stride)
  await unlink(full).catch(() => {})
  return reduced
}

// Per-frame durations (ms) of an animated WebP, read from `webpmux -info` (duration is the 7th column).
async function frameDurations (p) {
  const info = await runCmd('webpmux', ['-info', p], true)
  const durs = []
  for (const line of info.split('\n')) {
    const m = line.match(/^\s*\d+:\s+\d+\s+\d+\s+\S+\s+\d+\s+\d+\s+(\d+)\s/)
    if (m) durs.push(parseInt(m[1], 10))
  }
  return durs
}
// Export an animated WebP at a chosen resolution + frame rate. Resizing preserves aspect (target width);
// a target fps resamples to constant frame rate while preserving real-time duration; fps 0 keeps native
// (variable) timing. ffmpeg can't read our animated WebP, so this stays on ImageMagick + img2webp/webpmux.
async function reencodeWebp (inPath, { width, height, fps, quality = 80, lossless = false }) {
  const base = join(tmpdir(), 'pp-exp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
  const dir = base + '-f'
  await mkdir(dir, { recursive: true })
  const out = base + '.webp'
  try {
    // width+height → crop-to-fit an exact WxH (cover: scale to fill, centre-crop — no distortion, e.g. 7:4→16:9).
    // width only → scale to that width, keep source aspect.  neither → native.
    const scale = (width && height)
      ? ['-resize', `${width}x${height}^`, '-gravity', 'center', '-extent', `${width}x${height}`]
      : width ? ['-resize', String(width) + 'x'] : []
    await runCmd('magick', [inPath, '-coalesce', ...scale, join(dir, 'rf-%04d.png')])
    const files = (await readdir(dir)).filter(f => f.startsWith('rf-')).sort()
    if (!files.length) throw new Error('could not read frames')
    const durs = await frameDurations(inPath)
    if (fps && fps > 0) {
      // Resample to constant fps: pick the source frame active at each sample time; equal delays out.
      const total = durs.reduce((a, b) => a + b, 0) || files.length * 100
      const cum = []; let acc = 0; for (const d of durs) { cum.push(acc); acc += d }
      const frameAt = t => { let idx = 0; for (let i = 0; i < cum.length; i++) { if (t >= cum[i]) idx = i; else break } return idx }
      const step = 1000 / fps
      const N = Math.max(1, Math.round(total / step))
      const list = []
      for (let i = 0; i < N; i++) list.push(join(dir, files[Math.min(frameAt(i * step), files.length - 1)]))
      const q = lossless ? ['-lossless'] : ['-lossy', '-q', String(quality)]
      await runCmd('img2webp', ['-loop', '0', ...q, '-d', String(Math.round(step)), ...list, '-o', out])
    } else {
      // Keep native per-frame timing: re-encode each resized frame, reassemble with its original duration.
      const fa = []
      for (let i = 0; i < files.length; i++) {
        const wf = join(dir, 'w-' + String(i).padStart(4, '0') + '.webp')
        const q = lossless ? ['-define', 'webp:lossless=true'] : ['-quality', String(quality)]
        await runCmd('magick', [join(dir, files[i]), ...q, wf])
        fa.push('-frame', wf, `+${durs[i] || 100}+0+0+0-b`)
      }
      await runCmd('webpmux', [...fa, '-loop', '0', '-o', out])
    }
    const buf = await readFile(out)
    return 'data:image/webp;base64,' + buf.toString('base64')
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); await unlink(out).catch(() => {}) }
}

// Map a WebP-style quality (1-100, higher = better) to an x264 CRF (lower = better).
const mp4Crf = q => Math.min(30, Math.max(15, Math.round(30 - (Number(q) || 80) * 0.16)))
// Flatten a music-video timeline (clips looping under a song) into ONE file at a chosen resolution + frame rate.
// Each placement shows its clip, looping from its cue until the next cue; the video runs the song's length.
// format 'mp4' → H.264 + AAC (with the soundtrack); 'webp' → silent animated WebP. Returns the output path.
async function renderTimeline ({ clips, placements, audioPath, durationSec, width, height, fps, quality, lossless, format }) {
  const workBase = join(tmpdir(), 'pp-render-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
  const framesRoot = workBase + '-clips'
  const created = [framesRoot]
  await mkdir(framesRoot, { recursive: true })
  const out = workBase + '.' + (format === 'mp4' ? 'mp4' : 'webp')
  try {
    // Write each distinct clip to a temp file; pick the output canvas from the first placement's clip.
    const clipPaths = new Map()
    for (const c of clips) {
      const p = workBase + '-in-' + (slug(c.name, 20) || 'clip') + '-' + Math.random().toString(36).slice(2, 6) + '.webp'
      await writeFile(p, Buffer.from(c.data, 'base64')); clipPaths.set(c.name, p); created.push(p)
    }
    let W, H
    if (width && height) {
      W = width; H = height // explicit target (e.g. a 16:9 standard) — each clip cover-fits to it, cropping aspect
    } else {
      let baseSize = null // canvas from the LARGEST clip (highest res wins), then scale to the target width
      for (const [, p] of clipPaths) { const sz = await clipSize(p); if (sz && (!baseSize || sz.w * sz.h > baseSize.w * baseSize.h)) baseSize = sz }
      if (!baseSize) baseSize = { w: 1280, h: 720 }
      W = width || baseSize.w
      H = Math.round(W * baseSize.h / baseSize.w)
    }
    W -= W % 2; H -= H % 2; W = Math.max(2, W); H = Math.max(2, H) // even dims for H.264/yuv420p
    // Decode + cover-fit each distinct clip to WxH frames; remember each clip's frames + per-frame durations.
    const info = new Map()
    for (const [name, p] of clipPaths) {
      const dir = join(framesRoot, (slug(name, 20) || 'c') + '-' + Math.random().toString(36).slice(2, 6))
      await mkdir(dir, { recursive: true })
      await runCmd('magick', [p, '-coalesce', '-resize', `${W}x${H}^`, '-gravity', 'center', '-extent', `${W}x${H}`, join(dir, 'f-%04d.png')])
      const frames = (await readdir(dir)).filter(f => f.startsWith('f-')).sort().map(f => join(dir, f))
      if (!frames.length) continue
      let durs = await frameDurations(p)
      if (durs.length < frames.length) durs = durs.concat(Array(frames.length - durs.length).fill(durs[durs.length - 1] || 100))
      durs = durs.slice(0, frames.length)
      info.set(name, { frames, durs, total: durs.reduce((a, b) => a + b, 0) || frames.length * 100 })
    }
    const pls = placements.filter(pl => info.has(pl.name)).map(pl => ({ t: Number(pl.t) || 0, name: pl.name })).sort((a, b) => a.t - b.t)
    if (!pls.length) throw new Error('no usable placements (clip missing?)')
    let T = Number(durationSec) || 0
    if (!T) { const last = pls[pls.length - 1]; T = last.t + info.get(last.name).total / 1000 }
    T = Math.max(0.1, T)
    const step = 1 / fps
    const N = Math.max(1, Math.round(T * fps))
    const activeAt = t => { let cur = pls[0]; for (const s of pls) { if (s.t <= t) cur = s; else break } return cur }
    const frameAt = (ci, elapsedMs) => {
      const loopT = ((elapsedMs % ci.total) + ci.total) % ci.total
      let acc = 0
      for (let i = 0; i < ci.frames.length; i++) { acc += ci.durs[i]; if (loopT < acc) return ci.frames[i] }
      return ci.frames[ci.frames.length - 1]
    }
    const outFrames = []
    for (let i = 0; i < N; i++) { const t = i * step; const pl = activeAt(t); outFrames.push(frameAt(info.get(pl.name), (t - pl.t) * 1000)) }
    if (format === 'mp4') {
      const listPath = workBase + '-list.txt'; created.push(listPath)
      const esc = f => f.replace(/'/g, "'\\''")
      let txt = ''
      for (const f of outFrames) txt += `file '${esc(f)}'\nduration ${step.toFixed(6)}\n`
      txt += `file '${esc(outFrames[outFrames.length - 1])}'\n` // concat demuxer repeats the last frame
      await writeFile(listPath, txt)
      const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath]
      if (audioPath) args.push('-i', audioPath)
      args.push('-r', String(fps), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(lossless ? 16 : mp4Crf(quality)))
      if (audioPath) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest')
      args.push('-movflags', '+faststart', out)
      await runFfmpeg(args)
    } else {
      // Run-length collapse identical consecutive frames → few args, then img2webp with per-run durations.
      const runs = []
      for (const f of outFrames) { const l = runs[runs.length - 1]; if (l && l.f === f) l.n++; else runs.push({ f, n: 1 }) }
      const args = ['-loop', '0', ...(lossless ? ['-lossless'] : ['-lossy', '-q', String(quality)])]
      for (const r of runs) args.push('-d', String(Math.round(r.n * step * 1000)), r.f)
      args.push('-o', out)
      await runCmd('img2webp', args)
    }
    return out
  } finally { for (const f of created) await rm(f, { recursive: true, force: true }).catch(() => {}) }
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
  // ── Projects: current + recent, new, open ──
  if (url.pathname === '/api/project' && req.method === 'GET') {
    return sendJson(res, 200, { current: CURRENT, recent: RECENT, home: homedir(), lastRenderDir: LAST_RENDER_DIR })
  }
  if (url.pathname === '/api/project/new' && req.method === 'POST') {
    let body
    try { body = await readJson(req) } catch { return sendJson(res, 400, { error: 'bad request body' }) }
    const name = String(body.name || '').trim()
    if (!name) return sendJson(res, 400, { error: 'Project name is required.' })
    const mastersDir = resolveMastersDir(name, body.mastersDir)
    try { await mkdir(mastersDir, { recursive: true }) } catch (e) { return sendJson(res, 502, { error: 'Could not create masters folder: ' + e.message }) }
    CURRENT = { name, mastersDir }
    RECENT = [{ name, mastersDir, opened: Date.now() }, ...RECENT.filter(p => p.name !== name)].slice(0, 12)
    await persistProjects()
    return sendJson(res, 200, { current: CURRENT, recent: RECENT })
  }
  if (url.pathname === '/api/project/open' && req.method === 'POST') {
    let body
    try { body = await readJson(req) } catch { return sendJson(res, 400, { error: 'bad request body' }) }
    const p = RECENT.find(x => x.name === String(body.name || '').trim())
    if (!p) return sendJson(res, 404, { error: 'Project not found.' })
    try { await mkdir(p.mastersDir, { recursive: true }) } catch { /* keep going — folder may be on a detached drive */ }
    CURRENT = { name: p.name, mastersDir: p.mastersDir, renderDir: p.renderDir || '' }
    RECENT = [{ ...p, opened: Date.now() }, ...RECENT.filter(x => x.name !== p.name)]
    await persistProjects()
    return sendJson(res, 200, { current: CURRENT, recent: RECENT })
  }

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
    // One source (edit) OR several (merge/composite via nano-banana/edit's multi-image input). data: URLs only.
    let imageUrls
    if (Array.isArray(body.images)) {
      const arr = body.images.filter(s => typeof s === 'string' && s.startsWith('data:'))
      if (arr.length) imageUrls = arr
    } else if (typeof body.image === 'string' && body.image.startsWith('data:')) {
      imageUrls = [body.image]
    }
    try {
      const { dataUrl, master } = await falImage({ prompt: String(body.prompt).trim(), model: body.model, aspectRatio: body.aspectRatio, width, height, imageUrls })
      return sendJson(res, 200, { dataUrl, master })
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
      const { buffer: mp4, master } = await falImageToVideo({ image: body.image, prompt })
      const out = await mp4ToAnimatedImage(mp4)
      return sendJson(res, 200, { ...out, master })
    } catch (e) {
      return sendJson(res, 502, { error: e.message || 'animation failed' })
    }
  }

  // ── Sequence clips → a looping animated WebP (add clip ×N, add clip ×N, …, at a chosen frame rate) ──
  if (url.pathname === '/api/sequence' && req.method === 'POST') {
    let body
    try { body = await readJson(req) } catch { return sendJson(res, 400, { error: 'bad request body' }) }
    const rawSteps = Array.isArray(body.steps) ? body.steps : []
    const tmp = []
    try {
      const steps = []
      for (const s of rawSteps) {
        const m = typeof s?.image === 'string' && s.image.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i)
        if (!m) continue
        const p = join(tmpdir(), 'pp-clip-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.webp')
        await writeFile(p, Buffer.from(m[1], 'base64')); tmp.push(p)
        steps.push({
          path: p,
          repeat: Math.min(50, Math.max(1, Math.floor(Number(s.repeat) || 1))),
          stride: Math.min(30, Math.max(1, Math.floor(Number(s.stride) || 1))),
        })
      }
      if (steps.length === 0) return sendJson(res, 400, { error: 'Add at least one clip.' })
      const outPath = await buildSequence(steps); tmp.push(outPath)
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

  // ── Export a built WebP at a chosen resolution + frame rate (native-res YouTube vs byte-efficient on-chain) ──
  if (url.pathname === '/api/export-webp' && req.method === 'POST') {
    let body
    try { body = await readJson(req) } catch { return sendJson(res, 400, { error: 'bad request body' }) }
    const m = typeof body.image === 'string' && body.image.match(/^data:image\/webp;base64,(.+)$/i)
    if (!m) return sendJson(res, 400, { error: 'Build a looping WebP first.' })
    const width = body.width ? Math.min(4096, Math.max(16, Math.round(Number(body.width) || 0))) : 0
    const height = body.height ? Math.min(4096, Math.max(16, Math.round(Number(body.height) || 0))) : 0 // with width → crop-to-fit
    const fps = body.fps ? Math.min(60, Math.max(1, Number(body.fps) || 0)) : 0
    const lossless = body.lossless === true || body.quality === 'lossless'
    const quality = lossless ? 80 : Math.min(100, Math.max(1, Math.round(Number(body.quality) || 80)))
    const inPath = join(tmpdir(), 'pp-expin-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.webp')
    try {
      await writeFile(inPath, Buffer.from(m[1], 'base64'))
      const dataUrl = await reencodeWebp(inPath, { width, height, fps, quality, lossless })
      return sendJson(res, 200, { dataUrl, size: Math.round(dataUrl.length * 3 / 4) })
    } catch (e) {
      return sendJson(res, 502, { error: e.message || 'export failed' })
    } finally { await unlink(inPath).catch(() => {}) }
  }

  // ── Render a music-video timeline → one file (MP4 w/ soundtrack, or silent WebP), at a chosen res + fps ──
  // Audio arrives first as a raw upload (base64 JSON would bloat a big FLAC past the 80MB body cap).
  if (url.pathname === '/api/render-audio' && req.method === 'POST') {
    try {
      const ext = (url.searchParams.get('ext') || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin'
      const buf = await readRawBody(req, 400e6)
      const name = 'pp-raudio-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.' + ext
      await writeFile(join(tmpdir(), name), buf)
      return sendJson(res, 200, { audioFile: name })
    } catch (e) { return sendJson(res, 502, { error: e.message || 'audio upload failed' }) }
  }
  if (url.pathname === '/api/render-timeline' && req.method === 'POST') {
    let body
    try { body = await readJson(req) } catch (e) { return sendJson(res, 400, { error: 'bad request body (' + e.message + ')' }) }
    const clips = Array.isArray(body.clips) ? body.clips.filter(c => c && c.name && typeof c.data === 'string') : []
    const placements = Array.isArray(body.placements) ? body.placements : []
    if (!clips.length || !placements.length) return sendJson(res, 400, { error: 'Need at least one clip and one timeline placement.' })
    const format = body.format === 'webp' ? 'webp' : 'mp4'
    const width = body.width ? Math.min(4096, Math.max(16, Math.round(Number(body.width) || 0))) : 0
    const height = body.height ? Math.min(4096, Math.max(16, Math.round(Number(body.height) || 0))) : 0 // with width → exact 16:9 canvas
    const fps = Math.min(60, Math.max(1, Math.round(Number(body.fps) || 24)))
    const lossless = body.lossless === true || body.quality === 'lossless'
    const quality = lossless ? 85 : Math.min(100, Math.max(1, Math.round(Number(body.quality) || 80)))
    const durationSec = Math.max(0, Number(body.durationSec) || 0)
    // Optional server-side save: write the render straight into a chosen folder (+ remember it) instead of
    // streaming it back for a browser download. Filename is sanitised and forced to the format's extension.
    const outDir = expandTilde(body.outDir)
    let filename = String(body.filename || '').replace(/[/\\]/g, '').trim().replace(/\.(mp4|webp)$/i, '')
    if (!filename) filename = 'music-video'
    filename += format === 'mp4' ? '.mp4' : '.webp'
    let audioPath = null
    if (format === 'mp4' && typeof body.audioFile === 'string') {
      const bn = body.audioFile.replace(/[^a-z0-9._-]/gi, '')
      if (bn.startsWith('pp-raudio-')) { const ap = join(tmpdir(), bn); if (existsSync(ap)) audioPath = ap }
    }
    let outPath
    try {
      outPath = await renderTimeline({ clips, placements, audioPath, durationSec, width, height, fps, quality, lossless, format })
    } catch (e) {
      if (audioPath) await unlink(audioPath).catch(() => {})
      return sendJson(res, 502, { error: e.message || 'render failed' })
    }
    if (audioPath) await unlink(audioPath).catch(() => {})
    if (outDir) {
      // Save straight into the chosen folder and remember it as the default for next time.
      try {
        await mkdir(outDir, { recursive: true })
        const dest = join(outDir, filename)
        const buf = await readFile(outPath)
        await writeFile(dest, buf)
        LAST_RENDER_DIR = outDir
        if (CURRENT) { CURRENT.renderDir = outDir; const rec = RECENT.find(p => p.name === CURRENT.name); if (rec) rec.renderDir = outDir } // remember per-project
        await persistProjects()
        return sendJson(res, 200, { saved: true, path: dest, size: buf.length })
      } catch (e) {
        return sendJson(res, 502, { error: 'Could not save to that folder: ' + e.message })
      } finally { await unlink(outPath).catch(() => {}) }
    }
    try {
      const buf = await readFile(outPath)
      res.writeHead(200, { 'content-type': format === 'mp4' ? 'video/mp4' : 'image/webp', 'content-length': buf.length })
      res.end(buf)
    } catch { sendJson(res, 502, { error: 'could not read rendered output' }) }
    finally { await unlink(outPath).catch(() => {}) }
    return
  }

  // ── Video (MP4/MOV/WebM) → downsized looping animated WebP (16:9 or square, low fps) for on-chain content ──
  // Trim the clip in a video editor first; this just squeezes it small enough to mint. Options via query string;
  // raw request body is the video file (base64 JSON would bloat a big clip by a third).
  //   ?aspect=16:9|1:1 · fps=15|7|5 · width=<96..1024> · q=<1..100>
  if (url.pathname === '/api/video-webp' && req.method === 'POST') {
    const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    const inPath = join(tmpdir(), 'pp-vid-' + stamp), outPath = join(tmpdir(), 'pp-vid-' + stamp + '.webp')
    try {
      const buf = await readRawBody(req, 400 * 1024 * 1024) // up to 400 MB source clip
      if (buf.length === 0) return sendJson(res, 400, { error: 'no video uploaded' })
      await writeFile(inPath, buf)
      const aspect = url.searchParams.get('aspect') === '1:1' ? '1:1' : '16:9'
      const fpsReq = Number(url.searchParams.get('fps'))
      const fps = [5, 7, 15].includes(fpsReq) ? fpsReq : 15
      const width = Math.min(Math.max(Number(url.searchParams.get('width')) || 480, 96), 1024)
      const qParam = url.searchParams.get('q'), lossless = qParam === 'lossless'
      const q = Math.min(Math.max(Number(qParam) || 55, 1), 100)
      const W = Math.round(width / 2) * 2
      const H = aspect === '1:1' ? W : Math.round((W * 9 / 16) / 2) * 2
      // cover-crop: scale up to fill WxH (keeping the source aspect), then centre-crop to exactly WxH — robust
      // for any input shape (16:9 in → no crop; other shapes → trimmed to the chosen frame), then drop the fps.
      const vf = `fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}`
      const encArgs = lossless ? ['-lossless', '1', '-q:v', '100'] : ['-lossless', '0', '-q:v', String(q)]
      await runFfmpeg(['-y', '-i', inPath, '-vcodec', 'libwebp', '-vf', vf, '-loop', '0', ...encArgs, '-compression_level', '6', '-an', outPath])
      const out = await readFile(outPath)
      let frames = 0
      try { frames = (await runCmd('magick', ['identify', '-format', '%T\n', outPath], true)).trim().split('\n').filter(Boolean).length } catch { /* leave 0 */ }
      const duration = frames ? frames / fps : 0
      return sendJson(res, 200, { dataUrl: 'data:image/webp;base64,' + out.toString('base64'), size: out.length, frames, duration, width: W, height: H, fps })
    } catch (e) {
      return sendJson(res, 502, { error: 'video conversion failed: ' + (e.message || 'error') })
    } finally {
      await unlink(inPath).catch(() => {}); await unlink(outPath).catch(() => {})
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

  // ── Tag a FLAC (metaflac) or MP3 (ffmpeg/ID3): text tags + cover art + lyrics ──
  // Body (JSON): { audio:<base64>, format:'flac'|'mp3', tags:{TITLE,ARTIST,ALBUM,DATE,COPYRIGHT,TRACKNUMBER,GENRE,COMMENT,…},
  //                lyrics:"<lrc/plain>", pictures:[{type:3|4|6, mime, width?, height?, data:<base64>}] }
  // FLAC = metaflac (cover art by role front/back/media + LYRICS tag). MP3 = ffmpeg ID3 (text tags + FRONT cover
  // APIC + best-effort lyrics; back/media roles are FLAC-only). `flac` is still accepted for the old key.
  if (url.pathname === '/api/tag' && req.method === 'POST') {
    const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    const tmp = [] // temp files to clean up
    try {
      const raw = await readRawBody(req, 800 * 1024 * 1024)
      let job
      try { job = JSON.parse(raw.toString('utf8')) } catch { return sendJson(res, 400, { error: 'bad request body' }) }
      const audioB64 = typeof job.audio === 'string' && job.audio ? job.audio : (typeof job.flac === 'string' ? job.flac : '')
      if (!audioB64) return sendJson(res, 400, { error: 'no audio provided' })
      const isMp3 = String(job.format || '').toLowerCase() === 'mp3'

      const tags = (job.tags && typeof job.tags === 'object') ? job.tags : {}
      const clean = Object.entries(tags)
        .map(([k, v]) => [String(k).toUpperCase().replace(/[^A-Z0-9_]/g, ''), v])
        .filter(([k, v]) => k && v != null && String(v).trim() !== '')
      const hasLyrics = typeof job.lyrics === 'string' && job.lyrics.trim() !== ''
      const pics = Array.isArray(job.pictures) ? job.pictures.filter(p => p && typeof p.data === 'string' && p.data) : []
      if (!clean.length && !hasLyrics && !pics.length) return sendJson(res, 400, { error: 'nothing to write — add text tags, cover art, or lyrics' })

      if (isMp3) {
        // ── MP3 / ID3 via ffmpeg: text tags + FRONT cover (APIC) + best-effort lyrics ──
        const inPath = join(tmpdir(), 'pp-tag-' + stamp + '.mp3'); tmp.push(inPath)
        const outPath = join(tmpdir(), 'pp-tag-' + stamp + '-out.mp3'); tmp.push(outPath)
        await writeFile(inPath, Buffer.from(audioB64, 'base64'))
        const front = pics.find(p => Number(p.type) === 3) || pics[0] || null // ID3 APIC = one front cover
        let coverPath = null
        if (front) {
          const mime = (typeof front.mime === 'string' && front.mime.startsWith('image/')) ? front.mime : 'image/jpeg'
          const ext = mime.split('/')[1].replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg'
          coverPath = join(tmpdir(), 'pp-cov-' + stamp + '.' + ext); tmp.push(coverPath)
          await writeFile(coverPath, Buffer.from(front.data, 'base64'))
        }
        // ffmpeg maps these generic keys to the right ID3 frames; unknown keys → lowercase (TXXX).
        const ID3 = { TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', ALBUMARTIST: 'album_artist', DATE: 'date', YEAR: 'date', TRACKNUMBER: 'track', TRACK: 'track', GENRE: 'genre', COPYRIGHT: 'copyright', COMMENT: 'comment' }
        const args = ['-y', '-i', inPath]
        if (coverPath) args.push('-i', coverPath)
        args.push('-map', '0:a')
        if (coverPath) args.push('-map', '1:v', '-disposition:v', 'attached_pic', '-metadata:s:v', 'title=Cover', '-metadata:s:v', 'comment=Cover (front)')
        else args.push('-map', '0:v?') // no new cover — keep the input's existing embedded cover if it has one
        args.push('-c', 'copy', '-id3v2_version', '3')
        for (const [k, v] of clean) args.push('-metadata', (ID3[k] || k.toLowerCase()) + '=' + String(v))
        if (hasLyrics) args.push('-metadata', 'lyrics=' + String(job.lyrics)) // best-effort USLT
        args.push(outPath)
        await runFfmpeg(args)
        const out = await readFile(outPath)
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-disposition': 'attachment; filename="tagged.mp3"', 'x-size': String(out.length) })
        return res.end(out)
      }

      // ── FLAC via metaflac: text tags + cover art by role (front/back/media) + lyrics ──
      const flacPath = join(tmpdir(), 'pp-tag-' + stamp + '.flac'); tmp.push(flacPath)
      await writeFile(flacPath, Buffer.from(audioB64, 'base64'))
      // Pass 1 — remove what we're about to (re)write so re-tagging never duplicates (leaves other tags intact).
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
      await runCmd('metaflac', [...set, flacPath])
      const out = await readFile(flacPath)
      res.writeHead(200, { 'content-type': 'audio/flac', 'content-disposition': 'attachment; filename="tagged.flac"', 'x-flac-size': String(out.length) })
      return res.end(out)
    } catch (e) {
      return sendJson(res, 502, { error: 'tagging failed: ' + (e.message || 'error') })
    } finally {
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
    // Local-first app served from disk — never let Chromium/Electron cache the app shell, or edits to
    // index.html/app.js won't show up on restart. No upside to caching a file that's already local.
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream', 'cache-control': 'no-store, must-revalidate' })
    res.end(data)
  } catch {
    res.writeHead(404); res.end('Not found')
  }
})

server.listen(PORT, () => {
  console.log(`\n  🏁 Pole Position → http://localhost:${PORT}`)
  console.log(`     writing: Claude Agent SDK on your subscription (no API key) · model: ${MODEL || 'plan default'}\n`)
})
