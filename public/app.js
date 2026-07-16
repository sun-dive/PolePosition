/* Pole Position — Phase 1 editor: chapters + Markdown + live preview + localStorage autosave.
   (Phase 2 adds Claude writing assist, Phase 3 fal images + cover, Phase 4 EPUB export, Phase 5 mint.) */
const LEGACY_KEY = 'polepos:draft' // pre-projects single draft (migrated once into a project)
const IDXKEY = 'polepos:projects'  // { activeId, list:[{id,name}] }
const MODEKEY = 'polepos:mode'     // 'rich' (default, visual) | 'md' (advanced, Markdown source)
const bookKey = id => 'polepos:book:' + id
const $ = id => document.getElementById(id)
const uid = () => 'c' + Math.random().toString(36).slice(2, 9)
const pid = () => 'p' + Math.random().toString(36).slice(2, 9)

function blank () {
  return { title: '', author: '', activeId: null, chapters: [{ id: uid(), title: 'Chapter 1', body: '' }] }
}
function normalize (b) { if (!b.activeId || !b.chapters.some(c => c.id === b.activeId)) b.activeId = b.chapters[0].id; return b }
function readBook (id) {
  try { const b = JSON.parse(localStorage.getItem(bookKey(id))); if (b && Array.isArray(b.chapters) && b.chapters.length) return normalize(b) } catch {}
  return null
}

// ---- projects index (one-time migration of the legacy single draft) ----
let projects = (() => {
  try { const x = JSON.parse(localStorage.getItem(IDXKEY)); if (x && Array.isArray(x.list) && x.list.length) return x } catch {}
  return null
})()
if (!projects) {
  let legacy = null
  try { const b = JSON.parse(localStorage.getItem(LEGACY_KEY)); if (b && Array.isArray(b.chapters) && b.chapters.length) legacy = normalize(b) } catch {}
  const id = pid(); const b = legacy || normalize(blank())
  projects = { activeId: id, list: [{ id, name: b.title || 'Untitled' }] }
  try { localStorage.setItem(bookKey(id), JSON.stringify(b)); localStorage.setItem(IDXKEY, JSON.stringify(projects)) } catch {}
}
let book = readBook(projects.activeId) || normalize(blank())

let saveTimer = null
function persistIndex () { try { localStorage.setItem(IDXKEY, JSON.stringify(projects)) } catch {} }
function syncProjectName () {
  const e = projects.list.find(p => p.id === projects.activeId), nm = book.title || 'Untitled'
  if (e && e.name !== nm) { e.name = nm; persistIndex(); renderProjects() }
}
function saveNow () { try { localStorage.setItem(bookKey(projects.activeId), JSON.stringify(book)); syncProjectName() } catch {} }
function save () {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(bookKey(projects.activeId), JSON.stringify(book)); syncProjectName(); flash('Saved') }
    catch { flash('Could not save (storage full?)') }
  }, 350)
}
function flash (msg) { $('status').textContent = msg }

const active = () => book.chapters.find(c => c.id === book.activeId)

/* ---- projects: switch / new / delete (each book is its own draft) ---- */
function renderProjects () {
  const sel = $('projectSelect'); if (!sel) return
  sel.innerHTML = ''
  projects.list.forEach(p => {
    const o = document.createElement('option')
    o.value = p.id; o.textContent = p.name || 'Untitled'
    if (p.id === projects.activeId) o.selected = true
    sel.appendChild(o)
  })
}
function loadActiveIntoEditor () {
  $('bookTitle').value = book.title || ''; $('bookAuthor').value = book.author || ''
  renderProjects(); renderChapters()
  if (richMode) mountRich(); else renderEditor()
  resetHistory() // undo history is per-book
  updateCoverButton() // book cover is per-book
}
async function switchProject (id) {
  if (!id || id === projects.activeId) return
  flushRich(); saveNow()
  projects.activeId = id; persistIndex()
  book = readBook(id) || normalize(blank())
  loadActiveIntoEditor()
  flash('Opened “' + (book.title || 'Untitled') + '”')
}
function newProject () {
  // No prompt() here: Electron doesn't support window.prompt (it throws), which silently killed this
  // button in the desktop app. Instead create the book with a default name and focus the title field —
  // typing the title renames the book live (see the #bookTitle oninput handler).
  flushRich(); saveNow()
  const id = pid(); const b = normalize(blank()); b.title = ''
  projects.list.push({ id, name: 'Untitled book' }); projects.activeId = id; persistIndex()
  try { localStorage.setItem(bookKey(id), JSON.stringify(b)) } catch {}
  book = b
  loadActiveIntoEditor()
  const t = $('bookTitle'); if (t) { t.focus() }
  flash('New book created — give it a title to start.')
}
function duplicateProject () {
  flushRich(); saveNow()
  const copy = JSON.parse(JSON.stringify(book))
  copy.title = (copy.title || 'Untitled') + ' (copy)'
  const id = pid()
  projects.list.push({ id, name: copy.title }); projects.activeId = id; persistIndex()
  try { localStorage.setItem(bookKey(id), JSON.stringify(copy)) } catch {}
  book = copy
  loadActiveIntoEditor()
  flash('Duplicated — you’re editing the copy; the original is untouched.')
}
function deleteProject () {
  if (projects.list.length === 1) { flash('You need at least one book.'); return }
  const e = projects.list.find(p => p.id === projects.activeId)
  if (!confirm('Delete “' + (e?.name || 'this book') + '”? This can’t be undone.')) return
  try { localStorage.removeItem(bookKey(projects.activeId)) } catch {}
  projects.list = projects.list.filter(p => p.id !== projects.activeId)
  projects.activeId = projects.list[0].id; persistIndex()
  book = readBook(projects.activeId) || normalize(blank())
  loadActiveIntoEditor()
  flash('Book deleted.')
}

/* ---- minimal Markdown → HTML (headings, bold, italic, links, bullet/numbered lists, quotes, hr) ---- */
function md (src) {
  const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  const inline = s => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" />')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  let html = '', list = null, inQuote = false
  const closeList = () => { if (list) { html += list === 'ol' ? '</ol>' : '</ul>'; list = null } }
  const closeQuote = () => { if (inQuote) { html += '</blockquote>'; inQuote = false } }
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    const uli = line.match(/^[-*]\s+(.*)$/)
    const oli = line.match(/^\d+\.\s+(.*)$/)
    const q = line.match(/^>\s?(.*)$/)
    if (uli) { closeQuote(); if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul' } html += `<li>${inline(uli[1])}</li>`; continue }
    if (oli) { closeQuote(); if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol' } html += `<li>${inline(oli[1])}</li>`; continue }
    closeList()
    if (q) { if (!inQuote) { html += '<blockquote>'; inQuote = true } html += `<p>${inline(q[1])}</p>`; continue }
    closeQuote()
    if (h) html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`
    else if (/^---+$/.test(line)) html += '<hr>'
    else if (line !== '') html += `<p>${inline(line)}</p>`
  }
  closeList(); closeQuote()
  return html || '<p class="dim">Nothing yet — start writing.</p>'
}

/* ---- render ---- */
function renderChapters () {
  const ol = $('chapterList'); ol.innerHTML = ''
  book.chapters.forEach((c, i) => {
    const li = document.createElement('li')
    li.className = c.id === book.activeId ? 'active' : ''
    li.innerHTML =
      `<span class="ci-name">${i + 1}. ${escapeHtml(c.title || 'Untitled')}</span>` +
      `<button class="ci-btn" data-up title="Move up">↑</button>` +
      `<button class="ci-btn" data-down title="Move down">↓</button>` +
      `<button class="ci-btn" data-del title="Delete">✕</button>`
    li.querySelector('.ci-name').onclick = () => selectChapter(c.id)
    li.querySelector('[data-up]').onclick = e => { e.stopPropagation(); moveChapter(i, -1) }
    li.querySelector('[data-down]').onclick = e => { e.stopPropagation(); moveChapter(i, 1) }
    li.querySelector('[data-del]').onclick = e => { e.stopPropagation(); deleteChapter(c.id) }
    ol.appendChild(li)
  })
}
function renderEditor () {
  const c = active()
  $('chapterTitle').value = c.title
  $('chapterBody').value = c.body
  const ar = document.getElementById('aiResult'); if (ar) ar.hidden = true // drop any stale AI result on chapter switch
  renderPreview()
}
function renderPreview () {
  $('previewBody').innerHTML = md($('chapterBody').value)
  const words = book.chapters.reduce((n, c) => n + (c.body.trim() ? c.body.trim().split(/\s+/).length : 0), 0)
  $('wordcount').textContent = words ? `${words.toLocaleString()} words` : ''
}
function escapeHtml (s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }

/* ---- actions ---- */
function selectChapter (id) { flushRich(); book.activeId = id; renderChapters(); refreshEditorView(); save() }
function addChapter () {
  flushRich(); recordBefore()
  const c = { id: uid(), title: `Chapter ${book.chapters.length + 1}`, body: '' }
  book.chapters.push(c); book.activeId = c.id; renderChapters(); refreshEditorView(); save(); recordNow()
}
function deleteChapter (id) {
  if (book.chapters.length === 1) { flash('A book needs at least one chapter.'); return }
  if (!confirm('Delete this chapter?')) return
  recordBefore()
  const i = book.chapters.findIndex(c => c.id === id)
  book.chapters.splice(i, 1)
  if (book.activeId === id) book.activeId = book.chapters[Math.max(0, i - 1)].id
  renderChapters(); refreshEditorView(); save(); recordNow()
}
function moveChapter (i, dir) {
  const j = i + dir
  if (j < 0 || j >= book.chapters.length) return
  recordBefore()
  ;[book.chapters[i], book.chapters[j]] = [book.chapters[j], book.chapters[i]]
  renderChapters(); save(); recordNow()
}

function exportDraft () {
  flushRich()
  const blob = new Blob([JSON.stringify(book, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = (book.title || 'pole-position-draft').replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.json'
  a.click(); URL.revokeObjectURL(a.href)
}
function importDraft (file) {
  const r = new FileReader()
  r.onload = () => {
    try {
      const b = JSON.parse(r.result)
      if (!b || !Array.isArray(b.chapters) || !b.chapters.length) throw new Error('bad draft')
      recordBefore() // keep the pre-import draft on the undo stack
      book = b; if (!book.chapters.some(c => c.id === book.activeId)) book.activeId = book.chapters[0].id
      $('bookTitle').value = book.title || ''; $('bookAuthor').value = book.author || ''
      renderChapters(); refreshEditorView(); save(); syncProjectName(); recordNow(); flash('Imported draft.')
    } catch { flash('That file isn’t a valid Pole Position draft.') }
  }
  r.readAsText(file)
}

/* ---- wire up ---- */
$('bookTitle').value = book.title || ''
$('bookAuthor').value = book.author || ''
$('bookTitle').oninput = e => {
  book.title = e.target.value; save(); recordSoon()
  const p = projects.list.find(p => p.id === projects.activeId) // keep the project dropdown in sync as you type
  if (p) { p.name = e.target.value.trim() || 'Untitled book'; persistIndex(); renderProjects() }
}
$('bookAuthor').oninput = e => { book.author = e.target.value; save(); recordSoon() }
$('chapterTitle').oninput = e => { active().title = e.target.value; renderChapters(); save(); recordSoon() }
$('chapterBody').oninput = e => { active().body = e.target.value; renderPreview(); save(); recordSoon() }
$('btnAddChapter').onclick = addChapter
$('btnExport').onclick = exportDraft
async function exportEpub () {
  flushRich()
  $('btnEpub').disabled = true; flash('Building EPUB…')
  try {
    const r = await fetch('/api/epub', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(book) })
    if (!r.ok) { const d = await r.json().catch(() => ({})); flash('EPUB: ' + (d.error || ('error ' + r.status))); return }
    const blob = await r.blob()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = (book.title || 'book').replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.epub'
    a.click(); URL.revokeObjectURL(a.href); flash('EPUB downloaded.')
  } catch (e) { flash('EPUB build failed — is the server running? ' + e.message) }
  finally { $('btnEpub').disabled = false }
}
$('btnEpub').onclick = exportEpub
// Encode an image to JPEG for the PDF, downscaling so its long edge is at most maxDim (0 = no cap). A screen/
// print ebook only needs ~150 DPI, so a 300-DPI master (e.g. a 2479×3508 A4 cover) is downscaled here — much
// smaller PDF + cheaper mint, no visible loss. Non-destructive: the source master is untouched.
function imgToJpeg (src, quality, maxDim = 0) {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight
      if (maxDim && Math.max(w, h) > maxDim) { const s = maxDim / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s) }
      const c = document.createElement('canvas'); c.width = w; c.height = h
      const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, 0, 0, w, h)
      resolve(c.toDataURL('image/jpeg', quality))
    }
    img.onerror = () => resolve(src) // fall back to the original if it can't load
    img.src = src
  })
}
async function exportPdf () {
  flushRich()
  $('btnPdf').disabled = true; flash('Preparing PDF (encoding images as JPEG)…')
  try {
  const css = `@page{size:A4;margin:18mm}
@page cover{size:A4;margin:0}
*{box-sizing:border-box}
body{font:16px/1.6 Georgia,'Times New Roman',serif;color:#111;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
h1,h2,h3,h4{font-family:-apple-system,system-ui,'Segoe UI',Roboto,sans-serif;line-height:1.25;break-after:avoid;page-break-after:avoid;break-inside:avoid}
h1{font-size:1.8em}h2{font-size:1.45em}
p{margin:0 0 .8em;orphans:2;widows:2}ul,ol{margin:0 0 .8em 1.4em}
li{break-inside:avoid;page-break-inside:avoid}
img{max-width:100%;height:auto;display:block;margin:1em auto;border-radius:6px;break-inside:avoid;page-break-inside:avoid}
blockquote{break-inside:avoid;page-break-inside:avoid;border-left:3px solid #ccc;margin:1em 0;padding:.2em 1em;color:#555}
a{color:#1a5fb4;text-decoration:none}hr{border:0;border-top:1px solid #ccc;margin:1.5em 0}
.cover{page:cover;margin:0;page-break-after:always;height:100vh;display:flex;align-items:center;justify-content:center;overflow:hidden}.cover img{display:block;max-width:100%;max-height:100%;border-radius:0}
.chapter{page-break-before:always}`
  // PNG masters in public/art stay untouched; encode JPEG only into this PDF
  const refs = new Set()
  book.chapters.forEach(c => { const re = /!\[[^\]]*\]\((art\/[^)]+)\)/g; let m; while ((m = re.exec(c.body || ''))) refs.add(m[1]) })
  const map = new Map()
  for (const ref of refs) map.set(ref, await imgToJpeg(location.origin + '/' + ref, 0.85, 1600))
  const coverJpeg = book.cover ? await imgToJpeg(book.cover, 0.9, 1800) : ''
  let chapters = book.chapters.map(c => `<section class="chapter">${md(c.body || '')}</section>`).join('\n')
  for (const [ref, jpeg] of map) chapters = chapters.split(`src="${ref}"`).join(`src="${jpeg}"`)
  const cover = coverJpeg ? `<div class="cover"><img src="${coverJpeg}" alt=""/></div>` : ''
  const auto = '<scr' + 'ipt>window.onload=function(){setTimeout(function(){window.print()},250)};window.onafterprint=function(){window.close()}</scr' + 'ipt>'
  const html = `<!doctype html><html><head><meta charset="utf-8"/><base href="${location.origin}/"/><title>${escapeHtml(book.title || 'Book')}</title><style>${css}</style></head><body>${cover}${chapters}${auto}</body></html>`
  const w = window.open('', '_blank')
  if (!w) { flash('Allow pop-ups for this page, then click 📄 PDF again (or use the browser’s Print → Save as PDF).'); return }
  w.document.open(); w.document.write(html); w.document.close()
  if (coverJpeg) {
    const base = (book.title || 'book').replace(/[^a-z0-9]+/gi, '-').toLowerCase()
    const a = document.createElement('a'); a.href = coverJpeg; a.download = base + '-cover.jpg'; a.click()
    flash('Cover downloaded; print view open — “Save as PDF” and name it to match.')
  } else flash('Opening print view — choose “Save as PDF”.')
  } finally { $('btnPdf').disabled = false }
}
$('btnPdf').onclick = exportPdf
$('btnImport').onclick = () => $('importFile').click()
$('importFile').onchange = e => { if (e.target.files[0]) importDraft(e.target.files[0]) }
$('projectSelect').onchange = e => switchProject(e.target.value)
$('btnNewProject').onclick = newProject
$('btnDupProject').onclick = duplicateProject
$('btnDeleteProject').onclick = deleteProject

/* ---- AI writing assist (P2): draft / continue / rewrite / outline via the local /api/write proxy ---- */
let aiResult = '', aiSel = { start: 0, end: 0 }
function showAiResult (text) { $('aiResultText').textContent = text; $('aiResult').hidden = false }
function hideAiResult () { $('aiResult').hidden = true; aiResult = '' }
function setAiBusy (b) { ['aiDraft', 'aiContinue', 'aiRewrite', 'aiOutline'].forEach(id => { $(id).disabled = b }) }

async function aiGenerate (mode) {
  flushRich()
  const body = $('chapterBody')
  if (richMode && mode === 'rewrite') { flash('Switch to Markdown mode to rewrite a selected passage.'); return }
  aiSel = richMode ? null : { start: body.selectionStart, end: body.selectionEnd }
  const selection = richMode ? '' : body.value.slice(aiSel.start, aiSel.end)
  const chapterText = richMode ? active().body : body.value
  // Optionally hand the AI the rest of the book (every other chapter) so new writing stays consistent
  // with what's already written — e.g. a solution chapter that references the problem set up earlier.
  const bookContext = ($('aiWholeBook') && $('aiWholeBook').checked)
    ? book.chapters.filter(c => c.id !== book.activeId).map(c => `## ${c.title || 'Untitled'}\n${(c.body || '').trim()}`).join('\n\n').trim()
    : ''
  if (mode === 'rewrite' && !selection.trim()) { flash('Select some text in the editor to rewrite first.'); return }
  setAiBusy(true); flash('Writing…')
  try {
    const r = await fetch('/api/write', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, instruction: $('aiPrompt').value.trim(), chapterText, selection, title: book.title, author: book.author, bookContext })
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { flash('AI: ' + (data.error || ('error ' + r.status))); return }
    aiResult = (data.text || '').trim()
    if (!aiResult) { flash('The AI returned nothing — try rephrasing your prompt.'); return }
    showAiResult(aiResult); flash('Review the draft below, then insert it.')
  } catch (e) {
    flash('AI request failed — is the server running? ' + e.message)
  } finally { setAiBusy(false) }
}

function applyText (start, end, text) {
  if (!text) return
  recordBefore() // snapshot before inserting AI text
  if (richMode) { // no textarea cursor in rich mode — append to the chapter and re-mount
    flushRich()
    const base = active().body
    active().body = base + (base && !base.endsWith('\n') ? '\n\n' : '') + text
    mountRich(); save(); recordNow(); hideAiResult(); flash('Added to the chapter.')
    return
  }
  const body = $('chapterBody'); const v = body.value
  const before = v.slice(0, start), after = v.slice(end)
  const sep = before && !before.endsWith('\n') ? '\n\n' : ''
  body.value = before + sep + text + after
  active().body = body.value
  const pos = (before + sep + text).length
  body.focus(); body.setSelectionRange(pos, pos)
  renderPreview(); save(); recordNow(); hideAiResult(); flash('Inserted.')
}

$('aiDraft').onclick = () => aiGenerate('draft')
$('aiContinue').onclick = () => aiGenerate('continue')
$('aiRewrite').onclick = () => aiGenerate('rewrite')
$('aiOutline').onclick = () => aiGenerate('outline')
$('aiInsert').onclick = () => applyText(aiSel?.start ?? 0, aiSel?.start ?? 0, aiResult)
$('aiReplace').onclick = () => applyText(aiSel?.start ?? 0, aiSel?.end ?? 0, aiResult)
$('aiAppend').onclick = () => { const b = $('chapterBody'); applyText(b.value.length, b.value.length, aiResult) }
$('aiDiscard').onclick = () => { hideAiResult(); flash('Discarded.') }
// Remember the "Whole book" context preference across sessions.
if ($('aiWholeBook')) {
  $('aiWholeBook').checked = localStorage.getItem('polepos:aiwhole') === '1'
  $('aiWholeBook').onchange = e => { try { localStorage.setItem('polepos:aiwhole', e.target.checked ? '1' : '0') } catch {} }
}

/* ---- Markdown formatting toolbar (no MD knowledge needed) ---- */
function commitBody () { active().body = $('chapterBody').value; renderPreview(); save(); recordNow() }
function replaceRange (start, end, text, selStart, selEnd) {
  recordBefore() // snapshot the pre-format state so Undo can return to it
  const t = $('chapterBody')
  t.value = t.value.slice(0, start) + text + t.value.slice(end)
  t.focus(); t.setSelectionRange(selStart, selEnd)
  commitBody()
}
function wrapInline (marker, placeholder) {
  const t = $('chapterBody'), s = t.selectionStart, e = t.selectionEnd
  const text = t.value.slice(s, e) || placeholder
  replaceRange(s, e, marker + text + marker, s + marker.length, s + marker.length + text.length)
}
function insertLink () {
  const t = $('chapterBody'), s = t.selectionStart, e = t.selectionEnd
  const label = t.value.slice(s, e) || 'link text', url = 'https://'
  const urlStart = s + 1 + label.length + 2 // past "[label]("
  replaceRange(s, e, `[${label}](${url})`, urlStart, urlStart + url.length)
}
function linePrefix (kind) {
  const t = $('chapterBody'), v = t.value, s = t.selectionStart, e = t.selectionEnd
  const ls = v.lastIndexOf('\n', s - 1) + 1
  let le = v.indexOf('\n', e); if (le === -1) le = v.length
  let n = 1
  const out = v.slice(ls, le).split('\n').map(line => {
    const bare = line.replace(/^(\s*)(#{1,4}\s+|[-*]\s+|\d+\.\s+|>\s?)/, '$1')
    if (kind === 'h1') return '# ' + bare
    if (kind === 'h2') return '## ' + bare
    if (kind === 'ul') return '- ' + bare
    if (kind === 'ol') return (n++) + '. ' + bare
    if (kind === 'quote') return '> ' + bare
    return bare
  }).join('\n')
  replaceRange(ls, le, out, ls, ls + out.length)
}
function mdAction (kind) {
  if (kind === 'bold') wrapInline('**', 'bold text')
  else if (kind === 'italic') wrapInline('*', 'italic text')
  else if (kind === 'link') insertLink()
  else linePrefix(kind) // h1, h2, ul, ol, quote
}
// keep the textarea focused/selected when a toolbar button is pressed
$('mdToolbar').addEventListener('mousedown', e => { if (e.target.closest('[data-md]')) e.preventDefault() })
$('mdToolbar').addEventListener('click', e => {
  const btn = e.target.closest('[data-md]'); if (btn) mdAction(btn.dataset.md)
})
$('chapterBody').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.key.toLowerCase()
    if (k === 'b') { e.preventDefault(); wrapInline('**', 'bold text') }
    else if (k === 'i') { e.preventDefault(); wrapInline('*', 'italic text') }
  }
})

/* ---- Rich (WYSIWYG) mode via Milkdown Crepe (window.PPMilkdown, from editor.bundle.js) ----
   Markdown stays canonical: edits round-trip through getMarkdown() into the same chapter.body. */
let richMode = false, richBusy = false
function updateWordcount () {
  const words = book.chapters.reduce((n, c) => n + (c.body.trim() ? c.body.trim().split(/\s+/).length : 0), 0)
  $('wordcount').textContent = words ? `${words.toLocaleString()} words` : ''
}
function flushRich () {
  if (richMode && window.PPMilkdown) { const m = window.PPMilkdown.getMarkdown(); if (m != null) active().body = m }
}
async function mountRich () {
  if (!window.PPMilkdown) return
  $('chapterTitle').value = active().title // keep the chapter-title input in sync (it lives outside the Milkdown body)
  await window.PPMilkdown.mount($('richEditor'), active().body, md => { active().body = md; updateWordcount(); save(); recordSoon() })
}
function refreshEditorView () { if (richMode) mountRich(); else renderEditor() }
function setModeButtons () {
  $('btnWysiwyg').classList.toggle('active', richMode)
  $('btnAdvanced').classList.toggle('active', !richMode)
}
async function enterRich () {
  if (!window.PPMilkdown) { flash('Rich editor isn’t loaded — run “npm run build:editor”. Using Markdown for now.'); setModeButtons(); return }
  richBusy = true; richMode = true
  document.body.classList.add('rich-mode'); setModeButtons()
  try {
    await mountRich()
    try { localStorage.setItem(MODEKEY, 'rich') } catch {}
    flash('Rich editing — your Markdown is saved underneath.')
  } catch (e) {
    richMode = false; document.body.classList.remove('rich-mode'); setModeButtons()
    flash('Rich editor failed to start: ' + e.message)
  } finally { richBusy = false }
}
async function exitRich () {
  richBusy = true
  flushRich()
  await window.PPMilkdown.destroy()
  richMode = false; document.body.classList.remove('rich-mode'); setModeButtons()
  try { localStorage.setItem(MODEKEY, 'md') } catch {}
  renderEditor(); save(); richBusy = false
}
$('btnWysiwyg').onclick = () => { if (!richBusy && !richMode) enterRich() }
$('btnAdvanced').onclick = () => { if (!richBusy && richMode) exitRich() }

/* ---- Undo / Redo (whole-book snapshots) ----
   Programmatic edits (toolbar, AI) wipe the textarea's native undo, so we keep our own stack.
   recordSoon() = debounced (typing); recordBefore()/recordNow() = immediate (discrete actions). */
const HIST_MAX = 150
let history = [], histIdx = -1, restoring = false, histTimer = null
function updateUndoButtons () {
  $('btnUndo').disabled = histIdx <= 0
  $('btnRedo').disabled = histIdx >= history.length - 1
}
function recordNow () {
  if (restoring) return
  const s = JSON.stringify(book)
  if (histIdx >= 0 && history[histIdx] === s) return // unchanged — skip
  history = history.slice(0, histIdx + 1) // drop any redo tail
  history.push(s)
  if (history.length > HIST_MAX) history.shift()
  histIdx = history.length - 1
  updateUndoButtons()
}
function recordSoon () { if (restoring) return; clearTimeout(histTimer); histTimer = setTimeout(recordNow, 500) }
function recordBefore () { clearTimeout(histTimer); recordNow() } // capture current state before a discrete change
async function restoreSnap (idx) {
  if (idx < 0 || idx >= history.length) return
  restoring = true
  histIdx = idx
  book = JSON.parse(history[idx])
  if (!book.chapters.some(c => c.id === book.activeId)) book.activeId = book.chapters[0].id
  $('bookTitle').value = book.title || ''; $('bookAuthor').value = book.author || ''
  renderChapters()
  if (richMode) await mountRich(); else renderEditor()
  try { localStorage.setItem(bookKey(projects.activeId), JSON.stringify(book)) } catch {}
  syncProjectName()
  updateUndoButtons()
  flash(idx === 0 ? 'Back to the start.' : 'Undone.')
  setTimeout(() => { restoring = false }, 0) // ignore any mount-triggered change events
}
function undo () {
  if (restoring) return
  clearTimeout(histTimer); recordNow() // flush any pending edit so it can be undone
  if (histIdx > 0) restoreSnap(histIdx - 1)
}
function redo () { if (restoring) return; clearTimeout(histTimer); if (histIdx < history.length - 1) restoreSnap(histIdx + 1) }
function resetHistory () { history = []; histIdx = -1; recordNow() } // fresh undo stack per book
$('btnUndo').onclick = undo
$('btnRedo').onclick = redo
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey)) return
  const k = e.key.toLowerCase()
  if (richMode) return // let Milkdown handle its own granular undo in Rich mode
  if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo() }
  else if (k === 'y') { e.preventDefault(); redo() }
})

/* ---- Cover image generator (P3 — fal.ai via /api/image) ---- */
const DEFAULT_COVER_PROMPT = `Premium book-cover illustration, portrait orientation. A warm cluster of glowing collectible NFTs floats in mid-air above a pair of open cupped hands that gently release them upward — a luminous ebook, a music NFT with soft sound-wave and musical-note motifs, and a framed digital artwork — each a hovering card edged in golden light. Deep charcoal background, subtle bokeh, faint flowing streams of data-particles (a quiet hint of AI and blockchain). Warm gold and amber glow against the dark; cinematic, photorealistic with a touch of magic, shallow depth of field. Bold title text near the top reading "AI Made It. You Own It." A smaller tagline beneath it reading "Content you own that pays you when it spreads." A small author credit near the bottom reading "Tommy Telford." Crisp, legible, well-kerned lettering; balanced high-end layout; highly detailed.`
// The has-cover indicator now lives on the single 🎨 Art button (book cover is set from that unified tool).
function updateCoverButton () { $('btnArt').classList.toggle('has-cover', !!book.cover) }
// A shape-selector value like "1:1@800" means: generate at aspect 1:1, then resize the result to 800×800.
// (fal's nano-banana works by aspect ratio, not pixels — so exact sizes are a client-side downscale.)
function parseShape (v) {
  v = String(v || '')
  // nano-banana has no A4 ratio → generate the nearest wider portrait (3:4) then crop the SIDES to A4 (210:297),
  // which trims only left/right background, never the (centred) title or author.
  if (v === 'A4') return { aspect: '3:4', px: 0, crop: [210, 297] }
  const [aspect, px] = v.split('@'); return { aspect: aspect || '2:3', px: px ? parseInt(px, 10) : 0, crop: null }
}
// Center-crop a data URL to a target aspect (aw:ah). Used for A4 covers. High-quality downscale of the crop.
function cropToAspectDataUrl (dataUrl, aw, ah) {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => {
      const target = aw / ah
      let sw = img.width, sh = img.height
      if (sw / sh > target) sw = Math.round(sh * target); else sh = Math.round(sw / target)
      const sx = Math.round((img.width - sw) / 2), sy = Math.round((img.height - sh) / 2)
      const c = document.createElement('canvas'); c.width = sw; c.height = sh
      const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
      resolve(c.toDataURL('image/png'))
    }
    img.onerror = () => resolve(dataUrl); img.src = dataUrl
  })
}
// Cover-crop-center an image data URL into a px×px WebP — the on-chain NFT cover size (matches the OG-crop pattern).
function toSquareDataUrl (dataUrl, px) {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = px; c.height = px
      const ctx = c.getContext('2d'); const s = Math.max(px / img.width, px / img.height)
      const dw = img.width * s, dh = img.height * s
      ctx.drawImage(img, (px - dw) / 2, (px - dh) / 2, dw, dh)
      resolve(c.toDataURL('image/webp', 0.92))
    }
    img.onerror = () => resolve(dataUrl); img.src = dataUrl
  })
}
// (The old separate Cover generator/animator lived here — merged into the single 🎨 Art tool below.)

/* ---- Sequence clips → a looping animated WebP cover (add clip ×N each, choose frame rate) ---- */
function renumberSeq () { Array.from($('seqList').children).forEach((li, i) => { li.querySelector('.seq-num').textContent = (i + 1) }) }
// Read an animated WebP's total playback time (ms) by summing ANMF frame durations — no decode needed.
function webpAnimDurationMs (buf) {
  const dv = new DataView(buf)
  if (dv.byteLength < 16 || dv.getUint32(0, false) !== 0x52494646 /*RIFF*/ || dv.getUint32(8, false) !== 0x57454250 /*WEBP*/) return null
  let off = 12, total = 0, found = false
  while (off + 8 <= dv.byteLength) {
    const fourcc = dv.getUint32(off, false), size = dv.getUint32(off + 4, true), payload = off + 8
    if (fourcc === 0x414e4d46 /*ANMF*/ && payload + 15 <= dv.byteLength) {
      const ms = dv.getUint8(payload + 12) | (dv.getUint8(payload + 13) << 8) | (dv.getUint8(payload + 14) << 16) // 24-bit LE ms
      total += Math.round(ms / 10) * 10 // ImageMagick re-times to centiseconds on output; match it so the estimate agrees with the build
      found = true
    }
    off = payload + size + (size & 1) // chunks are even-padded
  }
  return found ? total : null
}
// Live loop-length + size estimate. Duration = clip ms × repeat (frame-rate-independent); size ≈
// Σ(clip bytes × repeat) / stride — empirically ~4% conservative vs the actual build, so a safe ceiling.
function updateSeqEstimate () {
  const stride = $('seqFps').value === 'third' ? 3 : $('seqFps').value === 'half' ? 2 : 1
  let ms = 0, bytes = 0, known = true
  for (const li of Array.from($('seqList').children)) {
    const f = li.querySelector('.seq-file').files[0]; if (!f) continue
    const r = parseInt(li.querySelector('.seq-rep').value, 10) || 1
    const d = parseInt(li.dataset.durMs || '0', 10)
    if (d > 0) ms += d * r; else known = false
    bytes += f.size * r
  }
  if (bytes <= 0) { $('seqEstimate').textContent = ''; return }
  const mb = bytes / stride / 1048576
  $('seqEstimate').textContent = '≈ ' + (ms / 1000).toFixed(1) + 's loop' + (known ? '' : ' +') +
    ' · ~' + mb.toFixed(1) + ' MB' + (mb > 3 ? ' ⚠' : '')
}
function addSeqStep () {
  const li = document.createElement('li'); li.className = 'seq-step'
  li.innerHTML = '<span class="seq-num"></span>' +
    '<input type="file" accept="image/*" class="seq-file" />' +
    '<span class="seq-dur dim"></span>' +
    '<label class="dim" style="font-size:12px; white-space:nowrap">repeat ×<input type="number" class="seq-rep" min="1" max="50" value="1" /></label>' +
    '<button class="ghost seq-del" type="button" title="Remove">✕</button>'
  const file = li.querySelector('.seq-file'), durEl = li.querySelector('.seq-dur')
  file.onchange = async () => {
    li.dataset.durMs = '0'; durEl.textContent = ''
    const f = file.files[0]; if (!f) { updateSeqEstimate(); return }
    try { const ms = webpAnimDurationMs(await f.arrayBuffer()); if (ms) { li.dataset.durMs = String(ms); durEl.textContent = (ms / 1000).toFixed(1) + 's' } } catch {}
    updateSeqEstimate()
  }
  li.querySelector('.seq-rep').oninput = updateSeqEstimate
  li.querySelector('.seq-del').onclick = () => { li.remove(); renumberSeq(); updateSeqEstimate() }
  $('seqList').append(li); renumberSeq()
}
function readFileDataUrl (file) {
  return new Promise(resolve => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => resolve(null); r.readAsDataURL(file) })
}
let seqResultData = ''
async function buildSequenceClips () {
  const steps = []
  for (const li of Array.from($('seqList').children)) {
    const f = li.querySelector('.seq-file').files[0]; if (!f) continue
    const image = await readFileDataUrl(f); if (!image) continue
    steps.push({ image, repeat: parseInt(li.querySelector('.seq-rep').value, 10) || 1 })
  }
  if (steps.length === 0) { $('seqStatus').textContent = 'Add at least one clip (pick a file).'; return }
  $('seqBuild').disabled = true; $('seqStatus').textContent = 'Building… (assembling + rendering frames)'
  try {
    const r = await fetch('/api/sequence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fps: $('seqFps').value, steps }) })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { $('seqStatus').textContent = data.error || ('Error ' + r.status); return }
    seqResultData = data.dataUrl
    $('seqImg').src = seqResultData; $('seqResult').hidden = false
    const mb = data.size / 1048576
    const dur = data.duration || 0
    $('seqInfo').textContent = data.frames + ' frames · ' + dur.toFixed(1) + 's loop · ' + mb.toFixed(2) + ' MB'
    $('seqStatus').textContent = mb > 3
      ? 'Built (' + mb.toFixed(2) + ' MB) — large for on-chain; try a lower frame rate or fewer repeats.'
      : 'Built (' + mb.toFixed(2) + ' MB) — on-chain-friendly. Download + embed in Kid3.'
  } catch (e) { $('seqStatus').textContent = 'Request failed — is the server running? ' + e.message }
  finally { $('seqBuild').disabled = false }
}
function downloadSeq () {
  if (!seqResultData) return
  const a = document.createElement('a'); a.href = seqResultData
  a.download = (book.title || 'cover').replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-loop.webp'; a.click()
}
function openSeq () { if ($('seqList').children.length === 0) { addSeqStep(); addSeqStep() } $('seqModal').hidden = false }
$('btnSeq').onclick = openSeq
$('seqClose').onclick = () => { $('seqModal').hidden = true }
$('seqModal').addEventListener('click', e => { if (e.target === $('seqModal')) $('seqModal').hidden = true })
$('seqAdd').onclick = addSeqStep
$('seqFps').onchange = updateSeqEstimate
$('seqBuild').onclick = buildSequenceClips
$('seqDownload').onclick = downloadSeq

/* ---- Music-video scene timeline → bundle (scenes + song + video.cue) for the PharLap player ----
   Two sections: ① a scene LIBRARY (each clip stored once) and ② a TIMELINE of placements (reuse clips freely).
   This mirrors the on-chain cost model — a clip placed at 5 times is one file + 5 short cue lines. */
let tlAudioUrl = '', tlAudioFile = null
const tlLib = new Map() // filename -> { file, url, dur } : the distinct scene clips, each stored once

// Seconds → LRC time "mm:ss.cc" (centiseconds), with carry so 59.999 → 01:00.00 not 00:60.00.
function fmtLrc (sec) {
  if (!isFinite(sec) || sec < 0) sec = 0
  let cs = Math.round(sec * 100)
  const m = Math.floor(cs / 6000); cs -= m * 6000
  const s = Math.floor(cs / 100); cs -= s * 100
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0')
}
function parseLrcTime (str) {
  const m = /^(\d{1,2}):(\d{1,2}(?:\.\d{1,2})?)$/.exec((str || '').trim())
  return m ? parseInt(m[1], 10) * 60 + parseFloat(m[2]) : null
}

/* --- ① Scene library --- */
async function addLibFiles (files) {
  for (const f of files) {
    if (tlLib.has(f.name)) continue // already in the library — stored once
    const entry = { file: f, url: URL.createObjectURL(f), dur: '' }
    tlLib.set(f.name, entry)
    try { const ms = webpAnimDurationMs(await f.arrayBuffer()); if (ms) entry.dur = (ms / 1000).toFixed(1) + 's' } catch { /* not animated */ }
  }
  renderLib(); refreshSceneSelects(); saveTimelineSoon()
}
function usageCount (name) { return Array.from($('tlList').children).filter(li => li.querySelector('.tl-scene').value === name).length }
function renderLib () {
  const ul = $('tlLib'); ul.textContent = ''
  if (tlLib.size === 0) { const li = document.createElement('li'); li.className = 'dim'; li.style.fontSize = '12px'; li.textContent = 'No scene clips yet — add WebP/GIF clips below.'; ul.append(li); return }
  for (const [name, e] of tlLib) {
    const li = document.createElement('li'); li.className = 'tl-lib-row'
    const img = document.createElement('img'); img.className = 'tl-lib-thumb'; img.src = e.url
    const nm = document.createElement('span'); nm.className = 'tl-lib-name'; nm.textContent = name; nm.title = name
    const du = document.createElement('span'); du.className = 'tl-lib-dur dim'; du.textContent = e.dur
    const n = usageCount(name)
    const use = document.createElement('span'); use.className = 'tl-lib-use dim'; use.textContent = n ? ('used ×' + n) : 'unused'
    const del = document.createElement('button'); del.className = 'ghost tl-lib-del'; del.type = 'button'; del.textContent = '✕'; del.title = 'Remove clip + its timeline placements'
    del.onclick = () => {
      URL.revokeObjectURL(e.url); tlLib.delete(name)
      Array.from($('tlList').children).forEach(li2 => { if (li2.querySelector('.tl-scene').value === name) li2.remove() })
      renumberTl(); renderLib(); refreshSceneSelects(); updateTlPreview(); saveTimelineSoon()
    }
    li.append(img, nm, du, use, del); ul.append(li)
  }
}

/* --- ② Timeline placements --- */
function sceneSelect (selected) {
  const sel = document.createElement('select'); sel.className = 'tl-scene'
  for (const name of tlLib.keys()) { const o = document.createElement('option'); o.value = name; o.textContent = name; if (name === selected) o.selected = true; sel.append(o) }
  return sel
}
function refreshSceneSelects () { // rebuild each placement's dropdown to reflect the current library, keeping its pick
  for (const li of Array.from($('tlList').children)) {
    const old = li.querySelector('.tl-scene'); const fresh = sceneSelect(old.value); fresh.onchange = old.onchange
    old.replaceWith(fresh)
  }
}
function renumberTl () { Array.from($('tlList').children).forEach((li, i) => { li.querySelector('.tl-num').textContent = (i + 1) }) }
function sortTl () {
  const list = $('tlList'), rows = Array.from(list.children)
  rows.sort((a, b) => (parseLrcTime(a.querySelector('.tl-time').value) ?? 1e9) - (parseLrcTime(b.querySelector('.tl-time').value) ?? 1e9))
  rows.forEach(r => list.append(r)); renumberTl(); saveTimelineSoon()
}
// Reorder a clip: swap its start time with the neighbour's (dir -1 = earlier/up, +1 = later/down), keeping the
// time slots intact — so the clip slides up/down the sequence and takes the neighbour's slot. The row (with its
// move buttons) follows the clip, so repeated clicks keep moving the same clip.
function moveTlRow (li, dir) {
  const rows = Array.from($('tlList').children)
  const i = rows.indexOf(li), j = i + dir
  if (j < 0 || j >= rows.length) return
  const a = li.querySelector('.tl-time'), b = rows[j].querySelector('.tl-time')
  const tmp = a.value; a.value = b.value; b.value = tmp
  sortTl(); updateTlPreview()
}
function addTlRow (presetName, presetTime) { // presets supplied when restoring from a cue/bundle
  if (tlLib.size === 0) { $('tlStatus').textContent = 'Add a scene clip first (section ①).'; return }
  const li = document.createElement('li'); li.className = 'tl-step'
  const num = document.createElement('span'); num.className = 'tl-num'
  const sel = sceneSelect(presetName || '') // defaults to the first library clip (or the preset, when restoring)
  const time = document.createElement('input'); time.type = 'text'; time.className = 'tl-time'; time.value = '00:00.00'; time.placeholder = '00:00.00'
  const setB = document.createElement('button'); setB.className = 'ghost tl-set'; setB.type = 'button'; setB.textContent = '⏱ Set'; setB.title = 'Set start from the song’s current position'
  const upB = document.createElement('button'); upB.className = 'ghost tl-move'; upB.type = 'button'; upB.textContent = '↑'; upB.title = 'Move this clip earlier (swap slot with the one above)'
  const dnB = document.createElement('button'); dnB.className = 'ghost tl-move'; dnB.type = 'button'; dnB.textContent = '↓'; dnB.title = 'Move this clip later (swap slot with the one below)'
  const delB = document.createElement('button'); delB.className = 'ghost tl-del'; delB.type = 'button'; delB.textContent = '✕'; delB.title = 'Remove'
  const a = $('tlPlayer')
  if (presetTime != null) time.value = presetTime
  else if (a.src && a.currentTime > 0) time.value = fmtLrc(a.currentTime) // default to current playback position
  sel.onchange = () => { renderLib(); updateTlPreview(); saveTimelineSoon() }
  setB.onclick = () => { if (!a.src) { $('tlStatus').textContent = 'Load a song first, then scrub + Set.'; return } time.value = fmtLrc(a.currentTime); sortTl(); updateTlPreview() }
  upB.onclick = () => moveTlRow(li, -1)
  dnB.onclick = () => moveTlRow(li, 1)
  time.onchange = () => { sortTl(); updateTlPreview() }
  delB.onclick = () => { li.remove(); renumberTl(); renderLib(); updateTlPreview(); saveTimelineSoon() }
  li.append(num, sel, time, upB, dnB, setB, delB)
  $('tlList').append(li); sortTl(); renderLib(); updateTlPreview()
}
function tlPlacements () {
  return Array.from($('tlList').children)
    .map(li => ({ t: parseLrcTime(li.querySelector('.tl-time').value), name: li.querySelector('.tl-scene').value }))
    .filter(s => s.t != null && s.name && tlLib.has(s.name))
    .map(s => ({ t: s.t, name: s.name, url: tlLib.get(s.name).url }))
    .sort((a, b) => a.t - b.t)
}
let tlCurrentT = null // which placement (by start time) is showing, so a clip's loop restarts when its cue fires
function updateTlPreview () {
  const scenes = tlPlacements(); if (scenes.length === 0) return
  const ct = $('tlPlayer').currentTime
  let cur = scenes[0]
  for (const s of scenes) { if (s.t <= ct) cur = s; else break }
  const img = $('tlPreview')
  if (cur.t === tlCurrentT && img.getAttribute('src')) return // same placement still active — let it keep looping
  tlCurrentT = cur.t
  img.style.display = 'block'; $('tlPreviewHint').style.display = 'none'
  // Restart the clip from frame 0 whenever its cue fires, so the loop syncs to the beat. A new URL loads fresh
  // at frame 0; a reused clip (same URL) needs a clear + reload to reset its animation to the start.
  if (img.getAttribute('src') === cur.url) { img.src = ''; requestAnimationFrame(() => { img.src = cur.url }) }
  else img.src = cur.url
}
function cueText () {
  const scenes = tlPlacements()
  return scenes.length ? scenes.map(s => '[' + fmtLrc(s.t) + ']' + s.name).join('\n') + '\n' : ''
}
function triggerDownload (blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
function downloadCue () {
  const text = cueText()
  if (!text) { $('tlStatus').textContent = 'Add at least one timeline placement.'; return }
  triggerDownload(new Blob([text], { type: 'text/plain' }), 'video.cue')
  $('tlStatus').textContent = 'Saved video.cue — mint it with the song + scene clips.'
}
// Transcode a raster STILL (PNG/JPEG) to WebP so the bundle rides small on-chain. Animated clips (WebP/GIF)
// pass through untouched so their motion survives. Returns { name, bytes } — stills get a .webp extension.
async function toWebpForExport (name, file, quality = 0.9) {
  if (!/\.(png|jpe?g)$/i.test(name)) return { name, bytes: new Uint8Array(await file.arrayBuffer()) }
  try {
    const bmp = await createImageBitmap(file)
    const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height
    cv.getContext('2d').drawImage(bmp, 0, 0); if (bmp.close) bmp.close()
    const blob = await new Promise(res => cv.toBlob(res, 'image/webp', quality))
    if (!blob) throw new Error('encode failed')
    return { name: name.replace(/\.(png|jpe?g)$/i, '.webp'), bytes: new Uint8Array(await blob.arrayBuffer()) }
  } catch { return { name, bytes: new Uint8Array(await file.arrayBuffer()) } } // fall back to the original bytes
}
async function downloadBundle () {
  const text = cueText()
  if (!text) { $('tlStatus').textContent = 'Add at least one timeline placement.'; return }
  const webp = !$('tlWebp') || $('tlWebp').checked
  $('tlStatus').textContent = webp ? 'Packing bundle (stills→WebP)…' : 'Packing bundle…'
  const entries = [], rename = new Map()
  let before = 0, after = 0
  for (const [name, e] of tlLib) {
    const out = webp ? await toWebpForExport(name, e.file) : { name, bytes: new Uint8Array(await e.file.arrayBuffer()) }
    rename.set(name, out.name); entries.push(out)
    before += e.file.size; after += out.bytes.length
  }
  if (tlAudioFile) entries.push({ name: tlAudioFile.name, bytes: new Uint8Array(await tlAudioFile.arrayBuffer()) })
  // Rebuild the cue with the (possibly renamed) filenames so its lines still match the packed clips.
  const cue = tlPlacements().map(s => '[' + fmtLrc(s.t) + ']' + (rename.get(s.name) || s.name)).join('\n') + '\n'
  entries.push({ name: 'video.cue', bytes: new TextEncoder().encode(cue) })
  triggerDownload(makeZip(entries), 'music-video-bundle.zip')
  const saved = before - after
  const savedMsg = webp && saved > 0 ? ` · WebP saved ${(saved / 1048576).toFixed(1)}MB` : ''
  $('tlStatus').textContent = 'Bundle ready (' + tlLib.size + ' clips' + (tlAudioFile ? ' + song' : '') + ' + cue' + savedMsg + '). Unzip, then mint all together in PharLap.'
}

/* --- minimal store-only ZIP (WebP/audio are already compressed, so no deflate needed) --- */
function crc32 (bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) { c ^= bytes[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) }
  return (~c) >>> 0
}
function makeZip (entries) {
  const enc = new TextEncoder(), parts = [], central = []
  let offset = 0
  const p16 = (a, n) => a.push(n & 0xff, (n >>> 8) & 0xff)
  const p32 = (a, n) => a.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff)
  for (const e of entries) {
    const name = enc.encode(e.name), data = e.bytes, crc = crc32(data)
    const lh = []; p32(lh, 0x04034b50); p16(lh, 20); p16(lh, 0); p16(lh, 0); p16(lh, 0); p16(lh, 0)
    p32(lh, crc); p32(lh, data.length); p32(lh, data.length); p16(lh, name.length); p16(lh, 0)
    const lhu = new Uint8Array(lh); parts.push(lhu, name, data)
    const ch = []; p32(ch, 0x02014b50); p16(ch, 20); p16(ch, 20); p16(ch, 0); p16(ch, 0); p16(ch, 0); p16(ch, 0)
    p32(ch, crc); p32(ch, data.length); p32(ch, data.length); p16(ch, name.length); p16(ch, 0); p16(ch, 0); p16(ch, 0); p16(ch, 0); p32(ch, 0); p32(ch, offset)
    central.push(new Uint8Array(ch), name)
    offset += lhu.length + name.length + data.length
  }
  let cSize = 0; for (const c of central) cSize += c.length
  const eo = []; p32(eo, 0x06054b50); p16(eo, 0); p16(eo, 0); p16(eo, entries.length); p16(eo, entries.length); p32(eo, cSize); p32(eo, offset); p16(eo, 0)
  return new Blob([...parts, ...central, new Uint8Array(eo)], { type: 'application/zip' })
}

/* --- Restore a saved project: ⬆ Load bundle (.zip) re-opens everything; ⬆ Load cue (.cue) rebuilds the
   timeline against clips already in the library. The bundle is the complete save file. --- */
// Read a store-only ZIP (the format makeZip writes) by walking its local file headers — no inflate needed.
function unzip (bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const dec = new TextDecoder()
  const out = []
  let off = 0
  while (off + 30 <= dv.byteLength && dv.getUint32(off, true) === 0x04034b50) {
    const compression = dv.getUint16(off + 8, true)
    const size = dv.getUint32(off + 18, true) // store: compressed size == uncompressed size
    const nameLen = dv.getUint16(off + 26, true), extraLen = dv.getUint16(off + 28, true)
    const nameStart = off + 30
    const name = dec.decode(bytes.subarray(nameStart, nameStart + nameLen))
    const dataStart = nameStart + nameLen + extraLen
    if (compression === 0) out.push({ name, bytes: bytes.subarray(dataStart, dataStart + size) })
    off = dataStart + size
  }
  return out
}
function mimeFromName (n) {
  const e = (n.split('.').pop() || '').toLowerCase()
  const map = { webp: 'image/webp', gif: 'image/gif', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', apng: 'image/apng',
    mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', aif: 'audio/aiff', aiff: 'audio/aiff', weba: 'audio/webm' }
  return map[e] || 'application/octet-stream'
}
function setSong (f) {
  if (!f) return
  if (tlAudioUrl) URL.revokeObjectURL(tlAudioUrl)
  tlAudioFile = f; tlAudioUrl = URL.createObjectURL(f)
  const a = $('tlPlayer'); a.src = tlAudioUrl; a.style.display = 'block'; $('tlAudioName').textContent = f.name
  saveTimelineSoon()
}
function clearTimeline () { $('tlList').innerHTML = ''; renumberTl() }
function clearLibrary () { for (const e of tlLib.values()) URL.revokeObjectURL(e.url); tlLib.clear() }
// Rebuild timeline placements from cue text (lines [mm:ss.cc]scene.webp). Clips must already be in the library.
function importCueText (text) {
  const re = /^\s*\[(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)\]\s*(\S.*?)\s*$/
  let added = 0, missing = 0
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const m = re.exec(line); if (!m) continue
    const name = m[3]
    if (!tlLib.has(name)) { missing++; continue }
    addTlRow(name, fmtLrc(parseInt(m[1], 10) * 60 + parseFloat(m[2])))
    added++
  }
  sortTl(); renderLib(); updateTlPreview()
  return { added, missing }
}
async function loadCueFile (file) {
  if (!file) return
  if (tlLib.size === 0) { $('tlStatus').textContent = 'Add your scene clips first (section ①), then load the cue.'; return }
  clearTimeline()
  const { added, missing } = importCueText(await file.text())
  $('tlStatus').textContent = `Loaded cue — ${added} placement${added === 1 ? '' : 's'} restored` + (missing ? `, ${missing} skipped (clip not in the library)` : '') + '.'
}
async function loadBundleFile (file) {
  if (!file) return
  $('tlStatus').textContent = 'Restoring bundle…'
  let entries
  try { entries = unzip(new Uint8Array(await file.arrayBuffer())) } catch { entries = [] }
  if (entries.length === 0) { $('tlStatus').textContent = 'Could not read that bundle (.zip).'; return }
  // Full restore → replace the current session.
  clearTimeline(); clearLibrary()
  if (tlAudioUrl) { URL.revokeObjectURL(tlAudioUrl); tlAudioUrl = ''; tlAudioFile = null }
  $('tlPlayer').removeAttribute('src'); $('tlPlayer').style.display = 'none'; $('tlAudioName').textContent = ''
  const sceneFiles = [], audioFiles = []
  let cue = null
  for (const e of entries) {
    if (/\.(cue|lrc)$/i.test(e.name)) cue = new TextDecoder().decode(e.bytes)
    else if (/\.(webp|gif|png|jpe?g|apng)$/i.test(e.name)) sceneFiles.push(new File([e.bytes], e.name, { type: mimeFromName(e.name) }))
    else if (/\.(mp3|flac|wav|m4a|aac|ogg|oga|opus|aiff?|weba)$/i.test(e.name)) audioFiles.push(new File([e.bytes], e.name, { type: mimeFromName(e.name) }))
  }
  await addLibFiles(sceneFiles)
  if (audioFiles[0]) setSong(audioFiles[0])
  let report = `Restored ${sceneFiles.length} clip${sceneFiles.length === 1 ? '' : 's'}` + (audioFiles[0] ? ' + song' : '')
  if (cue) { const { added, missing } = importCueText(cue); report += `, ${added} placement${added === 1 ? '' : 's'}` + (missing ? ` (${missing} skipped)` : '') }
  renderLib(); updateTlPreview()
  $('tlStatus').textContent = report + '.'
}

/* ---- Music-video timeline auto-persist (IndexedDB — survives reloads, big enough to hold the media) ----
   Blobs are too big for localStorage, so they live in IndexedDB: each scene clip + the song under its own
   key, plus a small "meta" record (clip list + durations + song name + the video.cue). Autosaves (debounced)
   on every edit; restores silently the first time you open the tool. A clip blob is immutable per filename,
   so it's written once — edits that only move placements rewrite just the tiny meta record. The bundle export
   stays the portable/complete save; this is the crash-safety net. */
const MV_DB = 'polepos-mv', MV_STORE = 'files'
let mvDbPromise = null
function mvDb () {
  if (!mvDbPromise) mvDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(MV_DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(MV_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return mvDbPromise
}
// One request per transaction, created + issued synchronously in the executor so the tx stays active.
function mvOp (mode, fn) {
  return mvDb().then(db => new Promise((resolve, reject) => {
    const req = fn(db.transaction(MV_STORE, mode).objectStore(MV_STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }))
}
const mvGet = k => mvOp('readonly', st => st.get(k))
const mvPut = (k, v) => mvOp('readwrite', st => st.put(v, k))
const mvDel = k => mvOp('readwrite', st => st.delete(k))
const mvKeys = () => mvOp('readonly', st => st.getAllKeys())

const mvPersisted = new Set() // clip keys already written (blobs are immutable per filename → write once)
let mvSongName = '', mvRestored = false, mvSaveTimer = null
function saveTimelineSoon () { clearTimeout(mvSaveTimer); mvSaveTimer = setTimeout(saveTimelineState, 700) }
async function saveTimelineState () {
  try {
    const clips = [], want = new Set(['meta'])
    for (const [name, e] of tlLib) {
      clips.push({ name, dur: e.dur }); const key = 'clip:' + name; want.add(key)
      if (!mvPersisted.has(key)) { await mvPut(key, e.file); mvPersisted.add(key) }
    }
    if (tlAudioFile) {
      want.add('song')
      if (mvSongName !== tlAudioFile.name) { await mvPut('song', tlAudioFile); mvSongName = tlAudioFile.name }
    }
    await mvPut('meta', { clips, songName: tlAudioFile ? tlAudioFile.name : '', cue: cueText() })
    for (const k of Array.from(mvPersisted)) if (!want.has(k)) { await mvDel(k); mvPersisted.delete(k) } // prune removed clips
    if (!tlAudioFile && mvSongName) { await mvDel('song'); mvSongName = '' }
  } catch { /* best-effort autosave — never block editing */ }
}
async function restoreTimelineState () {
  if (mvRestored) return
  mvRestored = true
  let meta
  try { meta = await mvGet('meta') } catch { return }
  if (!meta || ((!meta.clips || !meta.clips.length) && !meta.songName)) return
  try {
    const files = []
    for (const c of (meta.clips || [])) {
      const blob = await mvGet('clip:' + c.name)
      if (blob) { files.push(new File([blob], c.name, { type: mimeFromName(c.name) })); mvPersisted.add('clip:' + c.name) }
    }
    if (files.length) await addLibFiles(files)
    if (meta.songName) { const s = await mvGet('song'); if (s) { setSong(new File([s], meta.songName, { type: mimeFromName(meta.songName) })); mvSongName = meta.songName } }
    if (meta.cue) importCueText(meta.cue)
    renderLib(); updateTlPreview()
    const n = tlLib.size
    if (n) $('tlStatus').textContent = `Restored your last session — ${n} clip${n === 1 ? '' : 's'}${meta.songName ? ' + song' : ''}${meta.cue ? ' + timeline' : ''}.`
  } catch { /* ignore restore errors — leave a clean, empty tool */ }
}
async function clearTimelineStore () { try { for (const k of await mvKeys()) await mvDel(k) } catch {} mvPersisted.clear(); mvSongName = '' }
async function clearAllTimeline () {
  if (tlLib.size === 0 && !tlAudioFile && $('tlList').children.length === 0) { $('tlStatus').textContent = 'Already empty.'; return }
  if (!confirm('Clear the whole timeline — scene clips, song and placements — and the auto-saved session? (Download a bundle first if you want to keep it.)')) return
  clearTimeline(); clearLibrary()
  if (tlAudioUrl) URL.revokeObjectURL(tlAudioUrl)
  tlAudioUrl = ''; tlAudioFile = null
  $('tlPlayer').removeAttribute('src'); $('tlPlayer').style.display = 'none'; $('tlAudioName').textContent = ''
  $('tlPreview').removeAttribute('src'); $('tlPreview').style.display = 'none'; $('tlPreviewHint').style.display = ''
  renderLib(); refreshSceneSelects()
  await clearTimelineStore()
  $('tlStatus').textContent = 'Cleared — fresh timeline.'
}

function openTimeline () { restoreTimelineState(); renderLib(); $('tlModal').hidden = false }
$('btnTimeline').onclick = openTimeline
$('tlClose').onclick = () => { $('tlModal').hidden = true }
$('tlModal').addEventListener('click', e => { if (e.target === $('tlModal')) $('tlModal').hidden = true })
$('tlAddFiles').onchange = () => { const fs = Array.from($('tlAddFiles').files || []); if (fs.length) addLibFiles(fs); $('tlAddFiles').value = '' }
$('tlAdd').onclick = () => addTlRow()
$('tlDownload').onclick = downloadCue
$('tlClear').onclick = clearAllTimeline
$('tlBundle').onclick = downloadBundle
$('tlLoadBundle').onchange = () => { const f = $('tlLoadBundle').files[0]; if (f) loadBundleFile(f); $('tlLoadBundle').value = '' }
$('tlLoadCue').onchange = () => { const f = $('tlLoadCue').files[0]; if (f) loadCueFile(f); $('tlLoadCue').value = '' }
$('tlAudio').onchange = () => setSong($('tlAudio').files[0])
$('tlPlayer').addEventListener('timeupdate', updateTlPreview)
$('tlPlayer').addEventListener('seeked', updateTlPreview)
// The first clip is already on screen when you hit play, so updateTlPreview would skip it (same placement).
// Reset the tracker on play so the current clip restarts from frame 0 too — fixes the first clip not resyncing.
$('tlPlayer').addEventListener('play', () => { tlCurrentT = null; updateTlPreview() })

/* ---- Lyrics timeline → .lrc (tap along to the song to time each line) ---- */
let lyAudioUrl = '', lyCursor = 0
function setLySong (f) {
  if (!f) return
  if (lyAudioUrl) URL.revokeObjectURL(lyAudioUrl)
  lyAudioUrl = URL.createObjectURL(f)
  const a = $('lyPlayer'); a.src = lyAudioUrl; a.style.display = 'block'; $('lyAudioName').textContent = f.name
}
function lyRows () { return Array.from($('lyList').children) }
function renumberLy () { lyRows().forEach((li, i) => { li.querySelector('.ly-num').textContent = (i + 1) }) }
// The "armed" line is the one the next ⏱/Space will stamp; clicking a line's number re-arms from there.
function setLyCursor (i) {
  const rows = lyRows()
  lyCursor = Math.max(0, Math.min(i, rows.length))
  rows.forEach((li, k) => li.classList.toggle('armed', k === lyCursor))
  $('lyHint').textContent = rows.length === 0 ? '' : lyCursor >= rows.length ? 'All lines timed ✓' : `Next: line ${lyCursor + 1} of ${rows.length}`
  // Auto-scroll the armed line to the middle of the list so you never have to scroll while tapping along.
  const armed = rows[lyCursor]
  if (armed) { const list = $('lyList'); list.scrollTop = armed.offsetTop - (list.clientHeight - armed.clientHeight) / 2 }
}
function makeLyRow (text, time) {
  const li = document.createElement('li'); li.className = 'ly-row'
  const num = document.createElement('span'); num.className = 'ly-num'; num.title = 'Re-arm from this line'
  const t = document.createElement('input'); t.type = 'text'; t.className = 'ly-time'; t.value = time || ''; t.placeholder = '—'
  const txt = document.createElement('input'); txt.type = 'text'; txt.className = 'ly-text'; txt.value = text || ''
  const setB = document.createElement('button'); setB.className = 'ghost ly-set'; setB.type = 'button'; setB.textContent = '⏱'; setB.title = 'Stamp this line at the current playback time'
  const delB = document.createElement('button'); delB.className = 'ghost ly-del'; delB.type = 'button'; delB.textContent = '✕'; delB.title = 'Remove'
  setB.onclick = () => { const a = $('lyPlayer'); if (!a.src) { $('lyStatus').textContent = 'Load a song first.'; return } t.value = fmtLrc(a.currentTime); setLyCursor(lyRows().indexOf(li) + 1) }
  delB.onclick = () => { li.remove(); renumberLy(); setLyCursor(Math.min(lyCursor, lyRows().length)) }
  num.onclick = () => setLyCursor(lyRows().indexOf(li))
  li.append(num, t, txt, setB, delB)
  return li
}
function buildLyRows () {
  const lines = $('lyInput').value.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) { $('lyStatus').textContent = 'Paste some lyrics first.'; return }
  // Keep existing times for unchanged lines, so re-loading after a small edit doesn't wipe your timing.
  const existing = new Map(lyRows().map(li => [li.querySelector('.ly-text').value, li.querySelector('.ly-time').value]))
  $('lyList').innerHTML = ''
  for (const line of lines) $('lyList').append(makeLyRow(line, existing.get(line) || ''))
  renumberLy(); setLyCursor(0)
  $('lyStatus').textContent = `${lines.length} line${lines.length === 1 ? '' : 's'} loaded — play, then tap ⏱ (or Space) at the start of each.`
}
function lyStampNext () {
  let rows = lyRows()
  if (rows.length === 0) { // be forgiving: if lines are pasted but not yet "Loaded", build them now
    if ($('lyInput').value.trim()) { buildLyRows(); rows = lyRows() }
    if (rows.length === 0) { $('lyStatus').textContent = 'Paste your lyrics above, then tap to time them.'; return }
  }
  const a = $('lyPlayer'); if (!a.src) { $('lyStatus').textContent = 'Load a song first.'; return }
  if (lyCursor >= rows.length) { $('lyStatus').textContent = 'All lines timed ✓ — download the .lrc.'; return }
  rows[lyCursor].querySelector('.ly-time').value = fmtLrc(a.currentTime)
  setLyCursor(lyCursor + 1)
}
// Rows in entered order — lyrics stay in sequence, NEVER sorted (unlike scene placements).
function lyData () { return lyRows().map(li => ({ time: parseLrcTime(li.querySelector('.ly-time').value), text: li.querySelector('.ly-text').value.trim() })).filter(r => r.text) }
function downloadLrc () {
  const rows = lyData()
  if (rows.length === 0) { $('lyStatus').textContent = 'Nothing to export — load some lines.'; return }
  const timed = rows.filter(r => r.time != null)
  if (timed.length === 0) { $('lyStatus').textContent = 'No lines are timed yet — tap ⏱/Space along to the song, or use “plain text”.'; return }
  const text = rows.map(r => (r.time != null ? '[' + fmtLrc(r.time) + ']' : '') + r.text).join('\n') + '\n'
  triggerDownload(new Blob([text], { type: 'text/plain' }), 'lyrics.lrc')
  $('lyStatus').textContent = `Saved lyrics.lrc (${timed.length}/${rows.length} lines timed). Add it in Kid3 (USLT / LYRICS).`
}
function downloadLrcPlain () {
  const rows = lyData()
  if (rows.length === 0) { $('lyStatus').textContent = 'Nothing to export — load some lines.'; return }
  triggerDownload(new Blob([rows.map(r => r.text).join('\n') + '\n'], { type: 'text/plain' }), 'lyrics.lrc')
  $('lyStatus').textContent = `Saved plain lyrics.lrc (${rows.length} lines, no timing — scrolls in the player).`
}
async function loadLrcFile (file) {
  if (!file) return
  const rows = []
  for (const raw of (await file.text()).replace(/\r/g, '').split('\n')) {
    const line = raw.trim()
    if (!line || /^\[[a-z]+:/i.test(line)) continue // blank or LRC metadata tag (ti/ar/al/offset…)
    const m = /^\[(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)\]\s*(.*)$/.exec(line)
    if (m) rows.push({ time: fmtLrc(parseInt(m[1], 10) * 60 + parseFloat(m[2])), txt: m[3].replace(/^(?:\[[^\]]*\]\s*)+/, '').trim() })
    else rows.push({ time: '', txt: line })
  }
  if (rows.length === 0) { $('lyStatus').textContent = 'No lyric lines found in that file.'; return }
  $('lyInput').value = rows.map(r => r.txt).join('\n')
  $('lyList').innerHTML = ''
  for (const r of rows) $('lyList').append(makeLyRow(r.txt, r.time))
  renumberLy(); setLyCursor(0)
  $('lyStatus').textContent = `Loaded ${rows.length} line${rows.length === 1 ? '' : 's'} from .lrc — edit or re-time as needed.`
}
function openLyrics () { $('lyModal').hidden = false }
$('btnLyrics').onclick = openLyrics
$('lyClose').onclick = () => { $('lyModal').hidden = true }
$('lyModal').addEventListener('click', e => { if (e.target === $('lyModal')) $('lyModal').hidden = true })
$('lyAudio').onchange = () => setLySong($('lyAudio').files[0])
$('lyLoadLrc').onchange = () => { const f = $('lyLoadLrc').files[0]; if (f) loadLrcFile(f); $('lyLoadLrc').value = '' }
$('lyBuild').onclick = buildLyRows
$('lyStamp').onclick = lyStampNext
$('lyDownload').onclick = downloadLrc
$('lyDownloadPlain').onclick = downloadLrcPlain
// Live: highlight the line currently sounding (by its stamped time) so you can verify the sync as you play.
$('lyPlayer').addEventListener('timeupdate', () => {
  const ct = $('lyPlayer').currentTime; const rows = lyRows(); let active = -1
  rows.forEach((li, i) => { const t = parseLrcTime(li.querySelector('.ly-time').value); if (t != null && t <= ct) active = i })
  rows.forEach((li, i) => li.classList.toggle('playing', i === active))
})
// Space bar stamps the next line. Run in the CAPTURE phase and stop the event before it reaches the audio
// element (or any button), so its native play/pause can never fire — on BOTH keydown and keyup (browsers
// toggle media on either). Typing in a text field is left alone. Only keydown actually stamps.
function lyKeyGuard (e) {
  if ($('lyModal').hidden || e.code !== 'Space') return
  const tag = (e.target && e.target.tagName) || ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return // typing — leave Space alone
  e.preventDefault(); e.stopImmediatePropagation()
  if (e.type === 'keydown') lyStampNext()
}
document.addEventListener('keydown', lyKeyGuard, true)
document.addEventListener('keyup', lyKeyGuard, true)

/* ---- WAV → FLAC (server-side flac --best --verify; raw binary upload, no base64 bloat) ---- */
let flacFile = null
$('btnFlac').onclick = () => { $('flacModal').hidden = false }
$('flacClose').onclick = () => { $('flacModal').hidden = true }
$('flacModal').addEventListener('click', e => { if (e.target === $('flacModal')) $('flacModal').hidden = true })

// 📖 Book Cover — the flat cover/back generator (backcover.html) in a modal iframe; lazy-loaded on first open.
$('btnBookCover').onclick = () => {
  const f = $('bookCoverFrame'); if (!f.dataset.loaded) { f.src = 'backcover.html'; f.dataset.loaded = '1' }
  $('bookCoverModal').hidden = false
}
$('bookCoverClose').onclick = () => { $('bookCoverModal').hidden = true }
$('bookCoverModal').addEventListener('click', e => { if (e.target === $('bookCoverModal')) $('bookCoverModal').hidden = true })
$('flacInput').onchange = () => { flacFile = $('flacInput').files[0] || null; $('flacName').textContent = flacFile ? flacFile.name : ''; $('flacStatus').textContent = '' }
$('flacEncode').onclick = async () => {
  if (!flacFile) { $('flacStatus').textContent = 'Choose a WAV first.'; return }
  $('flacEncode').disabled = true; $('flacStatus').textContent = 'Encoding… (lossless, max compression — large files take a moment)'
  try {
    const r = await fetch('/api/flac', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: flacFile })
    if (!r.ok) { const d = await r.json().catch(() => ({})); $('flacStatus').textContent = d.error || ('Error ' + r.status); return }
    const blob = await r.blob()
    triggerDownload(blob, flacFile.name.replace(/\.wav$/i, '') + '.flac')
    const orig = +r.headers.get('x-orig-size') || flacFile.size, size = +r.headers.get('x-flac-size') || blob.size
    $('flacStatus').textContent = `Done — ${(size / 1048576).toFixed(1)} MB FLAC (${Math.round(100 * size / orig)}% of the WAV). Downloaded.`
  } catch (e) { $('flacStatus').textContent = 'Failed — is the server running? ' + e.message }
  finally { $('flacEncode').disabled = false }
}

/* ---- 🎥 Video → looping animated WebP: downsize a trimmed MP4/MOV for on-chain motion content ---- */
let videoFile = null, videoResultData = ''
$('btnVideo').onclick = () => { $('videoModal').hidden = false }
$('videoClose').onclick = () => { $('videoModal').hidden = true }
$('videoModal').addEventListener('click', e => { if (e.target === $('videoModal')) $('videoModal').hidden = true })
$('videoInput').onchange = () => { videoFile = $('videoInput').files[0] || null; $('videoName').textContent = videoFile ? videoFile.name : ''; $('videoStatus').textContent = ''; $('videoResult').hidden = true }
$('videoBuild').onclick = async () => {
  if (!videoFile) { $('videoStatus').textContent = 'Choose a video first.'; return }
  const qs = new URLSearchParams({ aspect: $('videoAspect').value, fps: $('videoFps').value, width: $('videoWidth').value, q: $('videoQ').value })
  $('videoBuild').disabled = true; $('videoStatus').textContent = 'Converting… (downsizing + encoding the loop — large clips take a moment)'
  try {
    const r = await fetch('/api/video-webp?' + qs, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: videoFile })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { $('videoStatus').textContent = data.error || ('Error ' + r.status); return }
    videoResultData = data.dataUrl
    $('videoImg').src = videoResultData; $('videoResult').hidden = false
    const kb = data.size / 1024, mb = data.size / 1048576
    const sizeStr = mb >= 1 ? mb.toFixed(2) + ' MB' : Math.round(kb) + ' KB'
    $('videoInfo').textContent = `${data.width}×${data.height} · ${data.fps} fps · ${data.frames} frames · ${(data.duration || 0).toFixed(1)}s · ${sizeStr}`
    $('videoStatus').textContent = mb > 3
      ? `Made (${sizeStr}) — large for on-chain; try a lower frame rate, smaller width, or a shorter clip.`
      : `Made (${sizeStr}) — on-chain-friendly. Download + mint in PharLap.`
  } catch (e) { $('videoStatus').textContent = 'Request failed — is the server running? ' + e.message }
  finally { $('videoBuild').disabled = false }
}
$('videoDownload').onclick = () => {
  if (!videoResultData) return
  const base = (videoFile ? videoFile.name.replace(/\.[^.]+$/, '') : 'clip').replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  const a = document.createElement('a'); a.href = videoResultData; a.download = base + '-loop.webp'; a.click()
}

/* ---- 🏷️ Tag editor: embed cover art by role + lyrics + text tags into a FLAC (/api/tag → metaflac) ---- */
let tagFlacFile = null, tagFlacBuf = null
const tagArt = { front: null, back: null, media: null } // each: { data:<base64>, mime, width, height }

// Read a FLAC's existing metadata client-side (so the editor + preview reflect what's ALREADY embedded).
function parseFlacMeta (arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer), dv = new DataView(arrayBuffer)
  const out = { tags: {}, lyrics: '', pictures: [] }
  if (u8.length < 4 || u8[0] !== 0x66 || u8[1] !== 0x4c || u8[2] !== 0x61 || u8[3] !== 0x43) return out // "fLaC"
  let pos = 4
  for (let g = 0; g < 4096; g++) {
    if (pos + 4 > u8.length) break
    const header = u8[pos], last = (header & 0x80) !== 0, type = header & 0x7f
    const len = (u8[pos + 1] << 16) | (u8[pos + 2] << 8) | u8[pos + 3]
    const body = pos + 4
    if (body + len > u8.length) break // truncated
    if (type === 4) { // VORBIS_COMMENT — 32-bit LITTLE-endian lengths
      let p = body
      const vlen = dv.getUint32(p, true); p += 4 + vlen
      const n = dv.getUint32(p, true); p += 4
      for (let i = 0; i < n && p + 4 <= body + len; i++) {
        const clen = dv.getUint32(p, true); p += 4
        const s = new TextDecoder().decode(u8.subarray(p, p + clen)); p += clen
        const eq = s.indexOf('=')
        if (eq > 0) {
          const k = s.slice(0, eq).toUpperCase(), v = s.slice(eq + 1)
          if (k === 'LYRICS' || k === 'UNSYNCEDLYRICS') { if (!out.lyrics) out.lyrics = v } else out.tags[k] = v
        }
      }
    } else if (type === 6) { // PICTURE — 32-bit BIG-endian fields
      let p = body
      const picType = dv.getUint32(p); p += 4
      const mlen = dv.getUint32(p); p += 4
      const mime = new TextDecoder().decode(u8.subarray(p, p + mlen)); p += mlen
      const dlen = dv.getUint32(p); p += 4 + dlen
      const width = dv.getUint32(p); p += 4
      const height = dv.getUint32(p); p += 4 + 4 + 4 // + depth + colors
      const datalen = dv.getUint32(p); p += 4
      out.pictures.push({ type: picType, mime, width, height, bytes: u8.slice(p, p + datalen) })
    }
    pos = body + len
    if (last) break
  }
  return out
}

// Read an MP3's ID3v2 (v2.3/v2.4) tags client-side — SAME {tags, lyrics, pictures} shape as parseFlacMeta,
// so prefillFromMeta works unchanged. Maps TIT2→TITLE, TPE1→ARTIST, TALB→ALBUM, TYER/TDRC→DATE, TRCK→TRACKNUMBER,
// TCON→GENRE, TCOP→COPYRIGHT, COMM→COMMENT; APIC→pictures (type 3/4/6); USLT→lyrics.
function parseMp3Meta (arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer), dv = new DataView(arrayBuffer)
  const out = { tags: {}, lyrics: '', pictures: [] }
  if (u8.length < 10 || u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return out // "ID3"
  const ver = u8[3] // 3 = v2.3, 4 = v2.4
  if (ver < 3) return out // v2.2 (3-char frame ids) unsupported
  const synch = (a, b, c, d) => (a << 21) | (b << 14) | (c << 7) | d
  const strip0 = s => s.replace(/[\s\u0000]+$/, '') // trailing whitespace + stray NUL terminators
  const decodeText = bytes => {
    if (!bytes.length) return ''
    const enc = bytes[0], body = bytes.subarray(1)
    try {
      if (enc === 1) return strip0(new TextDecoder('utf-16').decode(body))
      if (enc === 2) return strip0(new TextDecoder('utf-16be').decode(body))
      if (enc === 3) return strip0(new TextDecoder('utf-8').decode(body))
      return strip0(new TextDecoder('iso-8859-1').decode(body))
    } catch { return strip0(new TextDecoder().decode(body)) }
  }
  // advance past a null-terminated descriptor (double-null for UTF-16 encodings), return the new offset
  const afterDesc = (data, p, enc) => {
    if (enc === 1 || enc === 2) { while (p + 1 < data.length && !(data[p] === 0 && data[p + 1] === 0)) p += 2; return p + 2 }
    while (p < data.length && data[p] !== 0) p++; return p + 1
  }
  const TMAP = { TIT2: 'TITLE', TPE1: 'ARTIST', TALB: 'ALBUM', TYER: 'DATE', TDRC: 'DATE', TRCK: 'TRACKNUMBER', TCON: 'GENRE', TCOP: 'COPYRIGHT', TPE2: 'ALBUMARTIST' }
  const end = Math.min(u8.length, 10 + synch(u8[6], u8[7], u8[8], u8[9]))
  let pos = 10
  while (pos + 10 <= end) {
    const id = String.fromCharCode(u8[pos], u8[pos + 1], u8[pos + 2], u8[pos + 3])
    if (!/^[A-Z0-9]{4}$/.test(id)) break // padding / end of frames
    const size = ver === 4 ? synch(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7]) : dv.getUint32(pos + 4)
    const fbody = pos + 10
    if (size <= 0 || fbody + size > end) break
    const data = u8.subarray(fbody, fbody + size)
    if (id === 'APIC') {
      const enc = data[0]; let p = 1
      let me = p; while (me < data.length && data[me] !== 0) me++
      const mime = new TextDecoder('iso-8859-1').decode(data.subarray(p, me)); p = me + 1
      const picType = data[p]; p += 1
      p = afterDesc(data, p, enc)
      out.pictures.push({ type: picType, mime: mime || 'image/jpeg', width: 0, height: 0, bytes: data.slice(p) })
    } else if (id === 'USLT') {
      const enc = data[0]; const p = afterDesc(data, 4, enc)
      const text = decodeText(new Uint8Array([enc, ...data.subarray(p)]))
      if (!out.lyrics) out.lyrics = text
    } else if (id === 'COMM') {
      const enc = data[0]; const p = afterDesc(data, 4, enc)
      if (!out.tags.COMMENT) out.tags.COMMENT = decodeText(new Uint8Array([enc, ...data.subarray(p)]))
    } else if (id === 'TXXX') {
      // User-defined text: [enc][description NUL][value]. ffmpeg stores `comment` HERE, not in a COMM frame.
      const enc = data[0]; let p = 1; const dStart = p
      if (enc === 1 || enc === 2) { while (p + 1 < data.length && !(data[p] === 0 && data[p + 1] === 0)) p += 2 } else { while (p < data.length && data[p] !== 0) p++ }
      const desc = decodeText(new Uint8Array([enc, ...data.subarray(dStart, p)])).trim().toUpperCase()
      const vStart = (enc === 1 || enc === 2) ? p + 2 : p + 1
      const val = decodeText(new Uint8Array([enc, ...data.subarray(vStart)]))
      if (val && (desc === 'COMMENT' || desc === 'DESCRIPTION') && !out.tags.COMMENT) out.tags.COMMENT = val
    } else if (id[0] === 'T' && TMAP[id]) {
      const val = decodeText(data)
      if (val && !out.tags[TMAP[id]]) out.tags[TMAP[id]] = val
    }
    pos = fbody + size
  }
  return out
}

// Pick the right reader by magic bytes: "ID3" or an MPEG frame sync → MP3, else FLAC.
function parseAudioMeta (arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer)
  const isMp3 = (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) || (u8[0] === 0xff && (u8[1] & 0xe0) === 0xe0)
  return isMp3 ? parseMp3Meta(arrayBuffer) : parseFlacMeta(arrayBuffer)
}
function isMp3File (file) { return /\.mp3$/i.test(file?.name || '') || file?.type === 'audio/mpeg' }

function resetTagEditor () { // each file load starts clean — nothing stale/default carries over to block it
  for (const id of ['tagTitle', 'tagArtist', 'tagAlbum', 'tagYear', 'tagTrack', 'tagGenre', 'tagCopyright', 'tagComment', 'tagLyrics']) $(id).value = ''
  tagArt.front = tagArt.back = tagArt.media = null
  for (const [imgId, xId] of [['tagArtFrontImg', 'tagArtFrontX'], ['tagArtBackImg', 'tagArtBackX'], ['tagArtMediaImg', 'tagArtMediaX']]) {
    $(imgId).hidden = true; $(imgId).removeAttribute('src'); $(xId).hidden = true
  }
}
function prefillFromMeta (meta) {
  const set = (id, v) => { if (v) $(id).value = v } // the loaded file wins — show exactly what's embedded
  set('tagTitle', meta.tags.TITLE); set('tagArtist', meta.tags.ARTIST); set('tagAlbum', meta.tags.ALBUM)
  set('tagYear', meta.tags.DATE || meta.tags.YEAR); set('tagTrack', meta.tags.TRACKNUMBER || meta.tags.TRACK)
  set('tagGenre', meta.tags.GENRE); set('tagCopyright', meta.tags.COPYRIGHT); set('tagComment', meta.tags.COMMENT)
  if (meta.lyrics) $('tagLyrics').value = meta.lyrics
  const slots = { front: ['tagArtFrontImg', 'tagArtFrontX'], back: ['tagArtBackImg', 'tagArtBackX'], media: ['tagArtMediaImg', 'tagArtMediaX'] }
  for (const p of meta.pictures) {
    const role = p.type === 4 ? 'back' : p.type === 6 ? 'media' : 'front'
    tagArt[role] = { data: bytesToBase64(p.bytes), mime: p.mime || 'image/png', width: p.width || 0, height: p.height || 0 }
    const [imgId, xId] = slots[role]
    $(imgId).src = base64ToUrl(tagArt[role].data, tagArt[role].mime); $(imgId).hidden = false; $(xId).hidden = false
  }
}

function bytesToBase64 (bytes) { // chunked so it handles multi-MB files without blowing the call stack
  let bin = ''; const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH))
  return btoa(bin)
}
function imageDims (file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file); const im = new Image()
    im.onload = () => { resolve({ w: im.naturalWidth || 0, h: im.naturalHeight || 0 }); URL.revokeObjectURL(url) }
    im.onerror = () => { resolve({ w: 0, h: 0 }); URL.revokeObjectURL(url) }
    im.src = url
  })
}
function openTag () { $('tagModal').hidden = false }
$('btnTag').onclick = openTag
$('tagClose').onclick = () => { $('tagModal').hidden = true }
$('tagModal').addEventListener('click', e => { if (e.target === $('tagModal')) $('tagModal').hidden = true })
$('tagFlac').onchange = async () => {
  tagFlacFile = $('tagFlac').files[0] || null; tagFlacBuf = null
  resetTagEditor() // clear stale/default values so the loaded file's own tags show through
  $('tagFlacName').textContent = tagFlacFile ? tagFlacFile.name : ''
  $('tagWrite').textContent = '💾 Write tags → ' + (tagFlacFile && isMp3File(tagFlacFile) ? 'MP3' : 'FLAC')
  $('tagStatus').textContent = ''
  if (!tagFlacFile) return
  $('tagStatus').textContent = 'Reading existing tags…'
  try {
    tagFlacBuf = await tagFlacFile.arrayBuffer() // cached — reused when writing, so no second read
    prefillFromMeta(parseAudioMeta(tagFlacBuf)) // FLAC (Vorbis) or MP3 (ID3v2) — chosen by magic bytes
    $('tagStatus').textContent = 'Loaded — existing art / lyrics / tags shown below (edit, then Write or Preview).'
  } catch (e) { $('tagStatus').textContent = 'Loaded (couldn’t read existing tags: ' + e.message + ')' }
  // fallbacks only for what the file didn't carry (never overrides an embedded value)
  if (!$('tagTitle').value) $('tagTitle').value = tagFlacFile.name.replace(/\.(flac|mp3)$/i, '').replace(/_+/g, ' ')
  if (!$('tagCopyright').value) $('tagCopyright').value = '© ' + new Date().getFullYear() + ' sun-dive'
}
// Copy-tags: read another track's tags/art/lyrics into a clipboard, then paste them onto the loaded sample.
let copiedMeta = null
$('tagCopySrc').onchange = async () => {
  const f = $('tagCopySrc').files[0]; if (!f) return
  $('tagCopyName').textContent = 'Reading ' + f.name + '…'
  try {
    copiedMeta = parseAudioMeta(await f.arrayBuffer()) // FLAC or MP3 — same {tags, lyrics, pictures} shape
    const n = Object.values(copiedMeta.tags).filter(Boolean).length + copiedMeta.pictures.length + (copiedMeta.lyrics ? 1 : 0)
    $('tagPaste').disabled = n === 0
    $('tagCopyName').textContent = n ? `Copied ${n} field(s) from ${f.name} — load your sample above, then Paste tags.` : `No tags found in ${f.name}.`
  } catch (e) { copiedMeta = null; $('tagPaste').disabled = true; $('tagCopyName').textContent = 'Couldn’t read tags: ' + e.message }
  $('tagCopySrc').value = '' // allow re-selecting the same file
}
$('tagPaste').onclick = () => {
  if (!copiedMeta) return
  prefillFromMeta(copiedMeta) // applies every non-empty copied tag/art/lyric over the current fields
  $('tagStatus').textContent = 'Pasted copied tags — review, then Write or Preview.'
}
function wireArtSlot (role, inputId, imgId, xId) {
  $(inputId).onchange = async () => {
    const f = $(inputId).files[0]; if (!f) return
    const bytes = new Uint8Array(await f.arrayBuffer())
    const { w, h } = await imageDims(f)
    tagArt[role] = { data: bytesToBase64(bytes), mime: f.type || 'image/png', width: w, height: h }
    const img = $(imgId); img.src = URL.createObjectURL(f); img.hidden = false; $(xId).hidden = false
  }
  $(xId).onclick = () => { tagArt[role] = null; $(imgId).hidden = true; $(imgId).removeAttribute('src'); $(xId).hidden = true; $(inputId).value = '' }
}
wireArtSlot('front', 'tagArtFront', 'tagArtFrontImg', 'tagArtFrontX')
wireArtSlot('back', 'tagArtBack', 'tagArtBackImg', 'tagArtBackX')
wireArtSlot('media', 'tagArtMedia', 'tagArtMediaImg', 'tagArtMediaX')
$('tagLrc').onchange = async () => { const f = $('tagLrc').files[0]; if (f) $('tagLyrics').value = await f.text() }
$('tagWrite').onclick = async () => {
  if (!tagFlacFile) { $('tagStatus').textContent = 'Load a FLAC or MP3 first.'; return }
  const fmt = isMp3File(tagFlacFile) ? 'mp3' : 'flac'
  $('tagWrite').disabled = true; $('tagStatus').textContent = 'Reading audio…'
  try {
    const audioBytes = new Uint8Array(tagFlacBuf || await tagFlacFile.arrayBuffer())
    const tags = {
      TITLE: $('tagTitle').value.trim(), ARTIST: $('tagArtist').value.trim(), ALBUM: $('tagAlbum').value.trim(),
      DATE: $('tagYear').value.trim(), TRACKNUMBER: $('tagTrack').value.trim(), GENRE: $('tagGenre').value.trim(),
      COPYRIGHT: $('tagCopyright').value.trim(), COMMENT: $('tagComment').value.trim(),
    }
    const pictures = []
    if (tagArt.front) pictures.push({ type: 3, ...tagArt.front })
    if (tagArt.back) pictures.push({ type: 4, ...tagArt.back })
    if (tagArt.media) pictures.push({ type: 6, ...tagArt.media })
    $('tagStatus').textContent = 'Embedding tags… (large files take a moment)'
    const job = { format: fmt, audio: bytesToBase64(audioBytes), tags, lyrics: $('tagLyrics').value, pictures }
    const r = await fetch('/api/tag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(job) })
    if (!r.ok) { const d = await r.json().catch(() => ({})); $('tagStatus').textContent = d.error || ('Error ' + r.status); return }
    const blob = await r.blob()
    triggerDownload(blob, tagFlacFile.name.replace(/\.(flac|mp3)$/i, '') + '-tagged.' + fmt)
    $('tagStatus').textContent = `Done — tagged ${fmt.toUpperCase()} downloaded (${(blob.size / 1048576).toFixed(1)} MB). Ready to mint in PharLap.`
  } catch (e) { $('tagStatus').textContent = 'Failed — is the server running? ' + e.message }
  finally { $('tagWrite').disabled = false }
}

/* ---- ▶ Preview: play the tagged result exactly as PharLap's player renders it (disc/cover + synced lyrics) ---- */
let pvLines = [], pvArtUrl = null, pvAudioUrl = null
function base64ToUrl (b64, mime) {
  const bin = atob(b64); const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: mime || 'image/png' }))
}
function parseLrcLines (text) { // synced [mm:ss.xx] lines → {t,text}; plain lines kept (t=null); skips [ti:]/[ar:] tags
  const out = []
  for (const line of (text || '').split(/\r?\n/)) {
    const m = /^\s*\[(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)\]\s*(.*)$/.exec(line)
    if (m) out.push({ t: parseInt(m[1], 10) * 60 + parseFloat(m[2]), text: m[3] })
    else if (line.trim() && !/^\s*\[[a-z]+:/i.test(line)) out.push({ t: null, text: line.trim() })
  }
  return out
}
function pvEsc (s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) }
function renderPvLyrics () {
  $('pvLyric').innerHTML = pvLines.length
    ? pvLines.map((l, i) => `<div class="pv-line" data-i="${i}">${pvEsc(l.text || '·')}</div>`).join('')
    : '<span class="dim" style="font-size:12px">No lyrics loaded</span>'
}
function setPvMode (mode) {
  const art = mode === 'disc' ? (tagArt.media || tagArt.front) : mode === 'back' ? tagArt.back : (tagArt.front || tagArt.media)
  $('pvDisc').classList.toggle('active', mode === 'disc')
  $('pvCover').classList.toggle('active', mode === 'front')
  $('pvBack').classList.toggle('active', mode === 'back')
  const img = $('pvArt')
  if (pvArtUrl) { URL.revokeObjectURL(pvArtUrl); pvArtUrl = null }
  if (art) { pvArtUrl = base64ToUrl(art.data, art.mime); img.src = pvArtUrl } else { img.removeAttribute('src') }
  const spin = mode === 'disc'
  img.classList.toggle('spin', spin)
  img.classList.toggle('pv-paused', $('pvAudio').paused) // the disc only turns while the audio is playing
  img.style.borderRadius = spin ? '50%' : '10px'
}
function openPreview () {
  if (!tagFlacFile) { $('tagStatus').textContent = 'Load a FLAC or MP3 first.'; return }
  if (pvAudioUrl) URL.revokeObjectURL(pvAudioUrl)
  pvAudioUrl = URL.createObjectURL(tagFlacFile); $('pvAudio').src = pvAudioUrl
  $('pvMeta').textContent = [$('tagTitle').value.trim(), $('tagArtist').value.trim()].filter(Boolean).join(' — ')
  pvLines = parseLrcLines($('tagLyrics').value); renderPvLyrics()
  $('pvBack').hidden = !tagArt.back // only offer a Back view when there's a back cover
  setPvMode(tagArt.media ? 'disc' : (tagArt.front ? 'front' : 'disc'))
  $('previewModal').hidden = false
}
function closePreview () {
  $('previewModal').hidden = true
  const a = $('pvAudio'); a.pause(); a.removeAttribute('src'); a.load()
  if (pvAudioUrl) { URL.revokeObjectURL(pvAudioUrl); pvAudioUrl = null }
  if (pvArtUrl) { URL.revokeObjectURL(pvArtUrl); pvArtUrl = null }
}
$('tagPreview').onclick = openPreview
$('pvClose').onclick = closePreview
$('previewModal').addEventListener('click', e => { if (e.target === $('previewModal')) closePreview() })
$('pvDisc').onclick = () => setPvMode('disc')
$('pvCover').onclick = () => setPvMode('front')
$('pvBack').onclick = () => setPvMode('back')
$('pvAudio').addEventListener('play', () => $('pvArt').classList.remove('pv-paused'))
$('pvAudio').addEventListener('pause', () => $('pvArt').classList.add('pv-paused'))
$('pvAudio').addEventListener('timeupdate', () => {
  if (!pvLines.length) return
  const ct = $('pvAudio').currentTime
  let active = -1
  for (let i = 0; i < pvLines.length; i++) if (pvLines[i].t != null && pvLines[i].t <= ct) active = i
  $('pvLyric').querySelectorAll('.pv-line').forEach((el, i) => {
    const on = i === active; el.classList.toggle('pv-on', on)
    if (on) el.scrollIntoView({ block: 'nearest' })
  })
})

/* ---- Chapter art generator (P3 — reuses /api/image-prompt, /api/image, /api/save-image) ---- */
let artData = ''
const ART_TEMPLATES = [
  ['Gold glow on charcoal (signature)', 'luminous illustration in warm gold and amber glowing on a deep charcoal near-black background, soft floating light particles and a gentle glow, flat shapes with subtle depth, premium and cinematic with a touch of magic, elegant and cohesive, no text'],
  ['Blue isometric tech', 'clean isometric flat-vector illustration on a deep blue and teal background, softly glowing accent icons arranged with subtle highlights and depth, a modern tech aesthetic, crisp and cohesive, no text'],
  ['Flat vector', 'clean flat vector illustration, bold simple shapes, a limited harmonious palette, crisp edges, modern and minimal, no text'],
  ['Editorial line art', 'minimal single-weight line-art illustration on a light off-white background, one restrained accent colour, elegant and airy, no text'],
  ['Soft 3D render', 'soft rounded 3D render, gentle studio lighting, smooth matte materials, pastel palette, friendly and clean, no text'],
  ['Watercolour', 'soft watercolour illustration, gentle washes, subtle paper texture, a muted palette, hand-painted feel, no text'],
  ['Isometric infographic', 'clean isometric infographic illustration, flat shading, simple clear icons, a bright cohesive palette, diagram-like, no text']
]
function initArtTemplates () {
  const sel = $('artStyleTemplate'); sel.innerHTML = '<option value="">— load a style template —</option>'
  ART_TEMPLATES.forEach(([name, style]) => { const o = document.createElement('option'); o.value = style; o.textContent = name; sel.appendChild(o) })
}
function openArt () { $('artStyle').value = book.artStyle || ''; $('artModal').hidden = false }
function closeArt () { $('artModal').hidden = true }
async function optimizeArtPrompt () {
  const description = $('artDesc').value.trim()
  if (!description) { $('artOptStatus').textContent = 'Describe it first.'; return }
  $('artOptimize').disabled = true; $('artOptStatus').textContent = 'Claude is writing the prompt…'
  try {
    const kind = $('artPurpose').value === 'cover' ? 'cover' : 'inline'
    const r = await fetch('/api/image-prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description, kind, style: $('artStyle').value.trim(), aspect: parseShape($('artAspect').value).aspect }) })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { $('artOptStatus').textContent = data.error || ('Error ' + r.status); return }
    $('artPrompt').value = (data.prompt || '').trim(); $('artOptStatus').textContent = 'Prompt ready — tweak it or Generate.'
  } catch (e) { $('artOptStatus').textContent = 'Request failed — is the server running? ' + e.message }
  finally { $('artOptimize').disabled = false }
}
async function generateArt () {
  const base = $('artPrompt').value.trim()
  if (!base) { $('artStatus').textContent = 'Describe/optimize a prompt first.'; return }
  const style = $('artStyle').value.trim()
  const { aspect, px, crop } = parseShape($('artAspect').value)
  const frame = aspect === '16:9' ? 'Full-bleed wide landscape composition that fills the entire frame edge to edge — no empty side margins, not a small centred motif.'
    : aspect === '3:4' ? 'Full-bleed tall portrait composition that fills the frame top to bottom.'
    : 'Full-bleed composition that fills the entire square frame.'
  const cropNote = crop ? '\n\nKeep the title, main subject and author name centred with clear left and right margins — the sides will be trimmed to A4 proportions.' : ''
  const prompt = `${base}${style ? `\n\nArt style (apply consistently): ${style}` : ''}\n\n${frame}${cropNote}`
  $('artGen').disabled = true; $('artStatus').textContent = 'Generating… (can take 20–40s)'
  try {
    const r = await fetch('/api/image', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, aspectRatio: aspect }) })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { $('artStatus').textContent = data.error || ('Error ' + r.status); return }
    artData = crop ? await cropToAspectDataUrl(data.dataUrl, crop[0], crop[1]) : (px ? await toSquareDataUrl(data.dataUrl, px) : data.dataUrl)
    $('artImg').src = artData; $('artResult').hidden = false; $('artStatus').textContent = crop ? 'Done (A4) — insert, refine, or regenerate.' : (px ? `Done (${px}×${px}) — insert, refine, or regenerate.` : 'Done — insert, refine, or regenerate.')
  } catch (e) { $('artStatus').textContent = 'Request failed — is the server running? ' + e.message }
  finally { $('artGen').disabled = false }
}
async function editArt () {
  if (!artData) { $('artEditStatus').textContent = 'Generate or open an image first.'; return }
  const instr = $('artEditInstr').value.trim()
  if (!instr) { $('artEditStatus').textContent = 'Describe the change first.'; return }
  $('artEdit').disabled = true; $('artEditStatus').textContent = 'Editing… (can take 20–40s)'
  try {
    const r = await fetch('/api/image', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: instr, image: artData }) })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { $('artEditStatus').textContent = data.error || ('Error ' + r.status); return }
    { const { px, crop } = parseShape($('artAspect').value); artData = crop ? await cropToAspectDataUrl(data.dataUrl, crop[0], crop[1]) : (px ? await toSquareDataUrl(data.dataUrl, px) : data.dataUrl) }
    $('artImg').src = artData; $('artEditStatus').textContent = 'Edited — insert, or tweak the instruction and refine again.' // keep the instruction so you can re-run/tweak it
  } catch (e) { $('artEditStatus').textContent = 'Request failed — is the server running? ' + e.message }
  finally { $('artEdit').disabled = false }
}
async function insertArt () {
  if (!artData) { $('artStatus').textContent = 'Generate or open an image first.'; return }
  $('artInsert').disabled = true; $('artStatus').textContent = 'Saving + inserting…'
  try {
    const r = await fetch('/api/save-image', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataUrl: artData }) })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { $('artStatus').textContent = data.error || ('Error ' + r.status); return }
    const alt = ($('artDesc').value.trim() || 'illustration').replace(/[[\]\n]+/g, ' ').trim()
    const mark = `![${alt}](${data.url})`
    if (richMode) applyText(0, 0, mark)
    else { const t = $('chapterBody'); const p = (document.activeElement === t) ? t.selectionStart : t.value.length; applyText(p, p, mark) }
    closeArt(); flash('Art inserted into the chapter.')
  } catch (e) { $('artStatus').textContent = 'Request failed — is the server running? ' + e.message }
  finally { $('artInsert').disabled = false }
}
function downloadArt () {
  if (!artData) return
  const ext = (artData.slice(5, artData.indexOf(';')).split('/')[1]) || 'png'
  const a = document.createElement('a'); a.href = artData; a.download = 'chapter-art.' + ext; a.click()
}
// Crop the current image to 1344x768 (OG/social banner size) and download an optimized JPEG — in-browser, no deps.
function downloadBannerJpeg () {
  if (!artData) { $('artStatus').textContent = 'Generate or open an image first.'; return }
  const W = 1344, H = 768
  const img = new Image()
  img.onload = () => {
    const c = document.createElement('canvas'); c.width = W; c.height = H
    const ctx = c.getContext('2d')
    const scale = Math.max(W / img.width, H / img.height) // cover-crop, centered
    const dw = img.width * scale, dh = img.height * scale
    ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh)
    const a = document.createElement('a')
    a.href = c.toDataURL('image/jpeg', 0.85)
    a.download = 'banner-1344x768.jpg'; a.click()
    $('artStatus').textContent = 'Banner JPEG downloaded (1344×768).'
  }
  img.onerror = () => { $('artStatus').textContent = 'Could not load the image for banner export.' }
  img.src = artData
}
// Use the current image as THIS book's cover (the merged tool replaces the old Cover generator).
function useArtAsCover () {
  if (!artData) { $('artStatus').textContent = 'Generate or open an image first.'; return }
  book.cover = artData; save(); updateCoverButton()
  $('artStatus').textContent = 'Saved as this book’s cover.'; flash('Cover saved to this book.')
}
// Animate THIS image → a short looping WebP (fal image→video). For animated covers / FLAC art.
let artAnimData = ''
async function animateArt () {
  if (!artData) { $('artAnimStatus').textContent = 'Generate or open an image first.'; return }
  const prompt = $('artAnimPrompt').value.trim()
  $('artAnimate').disabled = true; $('artAnimStatus').textContent = 'Animating… (image→video can take a minute or two)'
  try {
    const r = await fetch('/api/animate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: artData, prompt }) })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { $('artAnimStatus').textContent = data.error || ('Error ' + r.status); return }
    artAnimData = data.dataUrl; $('artAnimImg').src = artAnimData; $('artAnimResult').hidden = false
    $('artAnimStatus').textContent = 'Done (' + (data.ext || 'webp') + ') — download it for an animated cover / FLAC art.'
  } catch (e) { $('artAnimStatus').textContent = 'Request failed — is the server running? ' + e.message }
  finally { $('artAnimate').disabled = false }
}
function downloadArtAnim () {
  if (!artAnimData) return
  const ext = artAnimData.slice(5, artAnimData.indexOf(';')).split('/')[1] || 'webp'
  const a = document.createElement('a'); a.href = artAnimData
  a.download = (book.title || 'art').replace(/[^\w.-]+/g, '_') + '-animated.' + ext; a.click()
}
// Motion presets + a Claude "suggest motion" — help write the animate prompt (subtle, loop-friendly).
const ANIM_TEMPLATES = [
  ['Character writes (text appears)', 'the character actively writes and the words appear stroke by stroke in the speech bubble / on the page as the pen moves; the rest of the scene stays still; seamless loop'],
  ['Character in action', 'the character performs its main action in a small, natural, looping motion (e.g. writing, gesturing, tapping); keep the face and features stable; seamless loop'],
  ['Drifting light particles', 'gentle drifting light particles with a soft glow that slowly pulses; the subject stays still; seamless loop'],
  ['Soft camera drift', 'very subtle slow camera drift, a barely-perceptible Ken-Burns push-in; seamless loop'],
  ['Shimmer on highlights', 'a soft shimmer and slow twinkle across the highlights and edges; everything else still; seamless loop'],
  ['Ambient glow pulse', 'a soft ambient glow that gently brightens and dims in a slow rhythm; seamless loop'],
  ['Floating dust / embers', 'faint floating dust motes and slow-rising embers drifting upward; subtle; seamless loop'],
  ['Energy particles rising', 'soft flowing energy and data particles drifting slowly upward behind the subject; seamless loop'],
  ['Mascot idle', 'very subtle idle motion — a slow gentle sway and a soft blink, with tiny background particle drift; keep the face and features stable; seamless loop'],
  ['Background parallax', 'gentle background parallax drift while the subject stays perfectly still; subtle; seamless loop']
]
function initAnimTemplates () {
  const sel = $('artAnimTemplate'); sel.innerHTML = '<option value="">— motion preset —</option>'
  ANIM_TEMPLATES.forEach(([name, motion]) => { const o = document.createElement('option'); o.value = motion; o.textContent = name; sel.appendChild(o) })
}
async function suggestMotion () {
  const desc = $('artPrompt').value.trim() || $('artDesc').value.trim()
  if (!desc) { $('artAnimSuggestStatus').textContent = 'Generate or describe an image first.'; return }
  $('artAnimSuggest').disabled = true; $('artAnimSuggestStatus').textContent = 'Claude is suggesting motion…'
  try {
    const r = await fetch('/api/image-prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: desc, kind: 'motion' }) })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { $('artAnimSuggestStatus').textContent = data.error || ('Error ' + r.status); return }
    $('artAnimPrompt').value = (data.prompt || '').trim(); $('artAnimSuggestStatus').textContent = 'Motion ready — tweak it or Animate.'
  } catch (e) { $('artAnimSuggestStatus').textContent = 'Request failed — is the server running? ' + e.message }
  finally { $('artAnimSuggest').disabled = false }
}
$('btnArt').onclick = openArt
$('artClose').onclick = closeArt
$('artModal').addEventListener('click', e => { if (e.target === $('artModal')) closeArt() })
$('artOptimize').onclick = optimizeArtPrompt
$('artGen').onclick = generateArt
$('artEdit').onclick = editArt
$('artUseCover').onclick = useArtAsCover
$('artCrop').onclick = openCrop

/* ---- ✂️ Interactive crop-to-aspect (drag to pan, slider to zoom; the bright frame is kept) ---- */
let cropImg = null
const cropState = { scale: 1, base: 1, x: 0, y: 0 }
function cropFrame () {
  const cv = $('cropCanvas'), pad = 26
  const [aw, ah] = $('cropAspect').value.split(':').map(Number)
  const availW = cv.width - pad * 2, availH = cv.height - pad * 2
  let fw = availW, fh = fw * ah / aw
  if (fh > availH) { fh = availH; fw = fh * aw / ah }
  return { x: (cv.width - fw) / 2, y: (cv.height - fh) / 2, w: fw, h: fh }
}
function cropFit () {
  const f = cropFrame()
  cropState.base = Math.max(f.w / cropImg.width, f.h / cropImg.height)
  $('cropZoom').value = 100
  cropState.scale = cropState.base
  cropState.x = f.x + (f.w - cropImg.width * cropState.scale) / 2
  cropState.y = f.y + (f.h - cropImg.height * cropState.scale) / 2
}
function cropClamp () {
  const f = cropFrame(), iw = cropImg.width * cropState.scale, ih = cropImg.height * cropState.scale
  cropState.x = Math.min(f.x, Math.max(f.x + f.w - iw, cropState.x))
  cropState.y = Math.min(f.y, Math.max(f.y + f.h - ih, cropState.y))
}
function cropDraw () {
  const cv = $('cropCanvas'), ctx = cv.getContext('2d'), f = cropFrame()
  ctx.fillStyle = '#0b0e13'; ctx.fillRect(0, 0, cv.width, cv.height)
  if (cropImg) ctx.drawImage(cropImg, cropState.x, cropState.y, cropImg.width * cropState.scale, cropImg.height * cropState.scale)
  ctx.fillStyle = 'rgba(6,8,12,.66)'
  ctx.fillRect(0, 0, cv.width, f.y)
  ctx.fillRect(0, f.y + f.h, cv.width, cv.height - f.y - f.h)
  ctx.fillRect(0, f.y, f.x, f.h)
  ctx.fillRect(f.x + f.w, f.y, cv.width - f.x - f.w, f.h)
  ctx.strokeStyle = '#e6b877'; ctx.lineWidth = 2; ctx.strokeRect(f.x + 1, f.y + 1, f.w - 2, f.h - 2)
}
function openCrop () {
  if (!artData) { $('artStatus').textContent = 'Generate or open an image first.'; return }
  cropImg = new Image()
  cropImg.onload = () => { cropFit(); cropClamp(); cropDraw(); $('cropInfo').textContent = cropImg.width + 'x' + cropImg.height + ' source'; $('cropModal').hidden = false }
  cropImg.src = artData
}
let cropDrag = null
$('cropCanvas').addEventListener('pointerdown', e => { if (!cropImg) return; cropDrag = { x: e.clientX, y: e.clientY, ox: cropState.x, oy: cropState.y }; $('cropCanvas').setPointerCapture(e.pointerId) })
$('cropCanvas').addEventListener('pointermove', e => {
  if (!cropDrag) return
  const cv = $('cropCanvas'), sc = cv.width / cv.clientWidth
  cropState.x = cropDrag.ox + (e.clientX - cropDrag.x) * sc
  cropState.y = cropDrag.oy + (e.clientY - cropDrag.y) * sc
  cropClamp(); cropDraw()
})
$('cropCanvas').addEventListener('pointerup', () => { cropDrag = null })
$('cropCanvas').addEventListener('pointercancel', () => { cropDrag = null })
$('cropZoom').addEventListener('input', () => {
  if (!cropImg) return
  const f = cropFrame(), z = parseInt($('cropZoom').value, 10) / 100
  const cx = (f.x + f.w / 2 - cropState.x) / cropState.scale, cy = (f.y + f.h / 2 - cropState.y) / cropState.scale
  cropState.scale = cropState.base * z
  cropState.x = f.x + f.w / 2 - cx * cropState.scale
  cropState.y = f.y + f.h / 2 - cy * cropState.scale
  cropClamp(); cropDraw()
})
$('cropAspect').addEventListener('change', () => { if (cropImg) { cropFit(); cropClamp(); cropDraw() } })
$('cropApply').onclick = () => {
  if (!cropImg) return
  const f = cropFrame(), s = cropState.scale
  const sx = (f.x - cropState.x) / s, sy = (f.y - cropState.y) / s, sw = f.w / s, sh = f.h / s
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(sw)); c.height = Math.max(1, Math.round(sh))
  const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(cropImg, sx, sy, sw, sh, 0, 0, c.width, c.height)
  artData = c.toDataURL('image/png')
  $('artImg').src = artData; $('artResult').hidden = false
  $('cropModal').hidden = true
  $('artStatus').textContent = 'Cropped to ' + c.width + 'x' + c.height + ' — Use as book cover, or insert.'
}
$('cropCancel').onclick = () => { $('cropModal').hidden = true }
$('cropClose').onclick = () => { $('cropModal').hidden = true }
$('cropModal').addEventListener('click', e => { if (e.target === $('cropModal')) $('cropModal').hidden = true })
$('artInsert').onclick = insertArt
$('artDownload').onclick = downloadArt
$('artBanner').onclick = downloadBannerJpeg
$('artAnimate').onclick = animateArt
$('artAnimDownload').onclick = downloadArtAnim
$('artAnimSuggest').onclick = suggestMotion
$('artAnimTemplate').onchange = e => { if (e.target.value) $('artAnimPrompt').value = e.target.value } // sticky: keep the chosen preset shown
$('artPurpose').onchange = e => { if (e.target.value === 'cover' && !$('artPrompt').value.trim()) $('artPrompt').value = DEFAULT_COVER_PROMPT }
$('artOpen').onclick = () => $('artFile').click()
$('artFile').onchange = e => {
  const f = e.target.files[0]; if (!f) return
  const rd = new FileReader()
  rd.onload = () => { artData = rd.result; $('artImg').src = artData; $('artResult').hidden = false; $('artStatus').textContent = 'Image loaded — insert or refine it.' }
  rd.readAsDataURL(f); e.target.value = ''
}
/* ---- Merge two images into one (nano-banana/edit multi-image composite) ---- */
let mergeA = null, mergeB = null
function wireMergeSlot (pickId, fileId, thumbId, set) {
  $(pickId).onclick = () => $(fileId).click()
  $(fileId).onchange = e => {
    const f = e.target.files && e.target.files[0]; if (!f) return
    const rd = new FileReader()
    rd.onload = () => { set(rd.result); const t = $(thumbId); t.src = rd.result; t.style.display = '' }
    rd.readAsDataURL(f); e.target.value = ''
  }
}
wireMergeSlot('mergePickA', 'mergeFileA', 'mergeThumbA', v => { mergeA = v })
wireMergeSlot('mergePickB', 'mergeFileB', 'mergeThumbB', v => { mergeB = v })
$('mergeGo').onclick = async () => {
  if (!mergeA || !mergeB) { $('mergeStatus').textContent = 'Pick both Image A and Image B first.'; return }
  const prompt = $('mergePrompt').value.trim() || 'Combine these two images into one cohesive, photorealistic composite scene — match the lighting and perspective so it reads as a single photograph.'
  const { aspect, px, crop } = parseShape($('artAspect').value)
  $('mergeGo').disabled = true; $('mergeStatus').textContent = 'Merging… (can take 20–40s)'
  try {
    const r = await fetch('/api/image', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, images: [mergeA, mergeB], aspectRatio: aspect }) })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { $('mergeStatus').textContent = data.error || ('Error ' + r.status); return }
    artData = crop ? await cropToAspectDataUrl(data.dataUrl, crop[0], crop[1]) : (px ? await toSquareDataUrl(data.dataUrl, px) : data.dataUrl)
    $('artImg').src = artData; $('artResult').hidden = false; $('mergeStatus').textContent = 'Merged — refine, crop, download, insert or animate below.'
  } catch (e) { $('mergeStatus').textContent = 'Request failed — is the server running? ' + e.message }
  finally { $('mergeGo').disabled = false }
}
$('artStyle').oninput = e => { book.artStyle = e.target.value; save() }
$('artStyleTemplate').onchange = e => { if (e.target.value) { $('artStyle').value = e.target.value; book.artStyle = e.target.value; save() } e.target.value = '' }
initArtTemplates()
initAnimTemplates()

renderProjects()
renderChapters(); renderEditor()
recordNow() // seed history with the loaded state

// Default to WYSIWYG mode; "Advanced" = Markdown source. Remember the user's last choice.
setModeButtons()
updateCoverButton()
if ((localStorage.getItem(MODEKEY) || 'rich') !== 'md') enterRich()

/* ---- Book Factory (stage 1: faster drafting) — brief → outline → full first draft → new book ----
   Keeps you in control: you review/edit the outline, then it drafts every chapter into a fresh book
   you can read, edit and illustrate as usual. The brief box is the seam a future niche-research step
   feeds; the finished book flows on to export + mint. */
let briefData = { title: '', subtitle: '', chapters: [] } // chapters: [{ title, synopsis }]

function openBrief () {
  $('briefStep1').hidden = false; $('briefStep2').hidden = true
  $('briefStatus1').textContent = ''; $('briefStatus2').textContent = ''
  $('briefProgress').hidden = true
  $('briefModal').hidden = false
}
function closeBrief () { $('briefModal').hidden = true }

function renderBriefChapters () {
  const ol = $('briefChapterList'); ol.innerHTML = ''
  briefData.chapters.forEach((c, i) => {
    const li = document.createElement('li'); li.className = 'brief-ch'
    li.innerHTML =
      `<span class="brief-ch-num">${i + 1}</span>` +
      '<div class="brief-ch-fields"><input class="bch-title" placeholder="Chapter title" /><textarea class="bch-syn" rows="2" placeholder="What this chapter delivers"></textarea></div>' +
      '<div class="brief-ch-ctl"><button class="ghost bch-up" type="button" title="Move up">↑</button><button class="ghost bch-down" type="button" title="Move down">↓</button><button class="ghost bch-del" type="button" title="Remove">✕</button></div>'
    const ti = li.querySelector('.bch-title'), sy = li.querySelector('.bch-syn')
    ti.value = c.title || ''; sy.value = c.synopsis || ''
    ti.oninput = e => { c.title = e.target.value }
    sy.oninput = e => { c.synopsis = e.target.value }
    li.querySelector('.bch-up').onclick = () => { if (i > 0) { const a = briefData.chapters; [a[i - 1], a[i]] = [a[i], a[i - 1]]; renderBriefChapters() } }
    li.querySelector('.bch-down').onclick = () => { const a = briefData.chapters; if (i < a.length - 1) { [a[i + 1], a[i]] = [a[i], a[i + 1]]; renderBriefChapters() } }
    li.querySelector('.bch-del').onclick = () => { briefData.chapters.splice(i, 1); renderBriefChapters() }
    ol.appendChild(li)
  })
}

async function briefGenerateOutline () {
  const brief = $('briefText').value.trim()
  if (!brief) { $('briefStatus1').textContent = 'Write a brief first.'; return }
  $('briefOutline').disabled = true; $('briefStatus1').textContent = 'Designing the outline…'
  try {
    const r = await fetch('/api/outline', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief, chapters: Number($('briefChapters').value) || 8, voice: $('briefVoice').value.trim() })
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { $('briefStatus1').textContent = 'Outline: ' + (data.error || ('error ' + r.status)); return }
    briefData = { title: data.title || '', subtitle: data.subtitle || '', chapters: Array.isArray(data.chapters) ? data.chapters : [] }
    $('briefTitle').value = briefData.title
    $('briefSubtitle').value = briefData.subtitle
    renderBriefChapters()
    $('briefStep1').hidden = true; $('briefStep2').hidden = false
    $('briefStatus2').textContent = 'Tweak the outline, then draft.'
  } catch (e) {
    $('briefStatus1').textContent = 'Outline failed — is the server running? ' + e.message
  } finally { $('briefOutline').disabled = false }
}

// Build a brand-new project from the drafted chapters (mirrors newProject(), with content).
function createBookFromDraft (title, subtitle, chapters) {
  flushRich(); saveNow()
  const id = pid()
  const b = { title: title || 'Untitled', author: '', activeId: null,
    chapters: chapters.map(c => ({ id: uid(), title: c.title || 'Untitled chapter', body: c.body || '' })) }
  if (subtitle) b.subtitle = subtitle
  normalize(b)
  projects.list.push({ id, name: b.title }); projects.activeId = id; persistIndex()
  try { localStorage.setItem(bookKey(id), JSON.stringify(b)) } catch {}
  book = b
  loadActiveIntoEditor()
}

async function briefDraftAll () {
  if (!briefData.chapters.length) { $('briefStatus2').textContent = 'Add at least one chapter.'; return }
  const title = $('briefTitle').value.trim() || briefData.title || 'Untitled'
  const subtitle = $('briefSubtitle').value.trim()
  const voice = $('briefVoice').value.trim()
  const chapters = briefData.chapters.map(c => ({ title: (c.title || '').trim() || 'Untitled chapter', synopsis: (c.synopsis || '').trim() }))
  $('briefDraft').disabled = true; $('briefBack').disabled = true; $('briefOutline').disabled = true
  const prog = $('briefProgress'), bar = $('briefProgressBar'); prog.hidden = false; bar.style.width = '0%'
  const drafted = []
  try {
    for (let i = 0; i < chapters.length; i++) {
      $('briefStatus2').textContent = `Drafting ${i + 1}/${chapters.length}: ${chapters[i].title}…`
      const r = await fetch('/api/draft-chapter', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, voice, outline: chapters, index: i })
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) { $('briefStatus2').textContent = `Stopped at ${i + 1}/${chapters.length}: ` + (data.error || ('error ' + r.status)); return }
      drafted.push({ title: chapters[i].title, body: (data.text || '').trim() })
      bar.style.width = Math.round(((i + 1) / chapters.length) * 100) + '%'
    }
    createBookFromDraft(title, subtitle, drafted)
    closeBrief()
    flash(`Drafted “${title}” — ${drafted.length} chapters. Read, edit, add a cover & art, then export.`)
  } catch (e) {
    $('briefStatus2').textContent = 'Draft failed — is the server running? ' + e.message
  } finally {
    $('briefDraft').disabled = false; $('briefBack').disabled = false; $('briefOutline').disabled = false
  }
}

$('btnBrief').onclick = openBrief
$('briefClose').onclick = closeBrief
$('briefModal').addEventListener('click', e => { if (e.target === $('briefModal')) closeBrief() })
$('briefOutline').onclick = briefGenerateOutline
$('briefBack').onclick = () => { $('briefStep1').hidden = false; $('briefStep2').hidden = true }
$('briefAddCh').onclick = () => { briefData.chapters.push({ title: '', synopsis: '' }); renderBriefChapters() }
$('briefDraft').onclick = briefDraftAll
