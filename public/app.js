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
  coverData = ''; updateCoverButton() // cover is per-book too
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
  flushRich(); saveNow()
  const name = (prompt('Name your new book (you can rename it anytime):', '') || '').trim()
  const id = pid(); const b = normalize(blank()); b.title = name
  projects.list.push({ id, name: name || 'Untitled' }); projects.activeId = id; persistIndex()
  try { localStorage.setItem(bookKey(id), JSON.stringify(b)) } catch {}
  book = b
  loadActiveIntoEditor()
  flash('New book created — start writing.')
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
$('bookTitle').oninput = e => { book.title = e.target.value; save(); recordSoon() }
$('bookAuthor').oninput = e => { book.author = e.target.value; save(); recordSoon() }
$('chapterTitle').oninput = e => { active().title = e.target.value; renderChapters(); save(); recordSoon() }
$('chapterBody').oninput = e => { active().body = e.target.value; renderPreview(); save(); recordSoon() }
$('btnAddChapter').onclick = addChapter
$('btnExport').onclick = exportDraft
$('btnImport').onclick = () => $('importFile').click()
$('importFile').onchange = e => { if (e.target.files[0]) importDraft(e.target.files[0]) }
$('projectSelect').onchange = e => switchProject(e.target.value)
$('btnNewProject').onclick = newProject
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
  if (mode === 'rewrite' && !selection.trim()) { flash('Select some text in the editor to rewrite first.'); return }
  setAiBusy(true); flash('Writing…')
  try {
    const r = await fetch('/api/write', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, instruction: $('aiPrompt').value.trim(), chapterText, selection, title: book.title, author: book.author })
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
let coverData = '' // last generated/loaded cover data URL for the active book
function updateCoverButton () { $('btnCover').classList.toggle('has-cover', !!book.cover) }
function openCover () {
  if (!$('coverPrompt').value.trim()) $('coverPrompt').value = DEFAULT_COVER_PROMPT
  if (book.cover && !coverData) { coverData = book.cover; $('coverImg').src = book.cover; $('coverResult').hidden = false; $('coverStatus').textContent = 'Current cover for this book.' }
  $('coverModal').hidden = false
}
function closeCover () { $('coverModal').hidden = true }
async function generateCover () {
  const prompt = $('coverPrompt').value.trim()
  if (!prompt) { $('coverStatus').textContent = 'Describe the cover first.'; return }
  $('coverGen').disabled = true; $('coverStatus').textContent = 'Generating… (can take 20–40s)'
  try {
    const r = await fetch('/api/image', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, aspectRatio: '2:3' }) })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { $('coverStatus').textContent = data.error || ('Error ' + r.status); return }
    coverData = data.dataUrl
    $('coverImg').src = coverData; $('coverResult').hidden = false; $('coverStatus').textContent = 'Done — use it, regenerate, or tweak the prompt.'
  } catch (e) {
    $('coverStatus').textContent = 'Request failed — is the server running? ' + e.message
  } finally { $('coverGen').disabled = false }
}
function useCover () {
  if (!coverData) return
  book.cover = coverData; save(); updateCoverButton()
  $('coverStatus').textContent = 'Saved as this book’s cover.'; flash('Cover saved to this book.')
}
function downloadCover () {
  if (!coverData) return
  const ext = (coverData.slice(5, coverData.indexOf(';')).split('/')[1]) || 'jpg'
  const a = document.createElement('a')
  a.href = coverData
  a.download = (book.title || 'cover').replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-cover.' + ext
  a.click()
}
async function optimizeCoverPrompt () {
  const description = $('coverDesc').value.trim()
  if (!description) { $('coverOptStatus').textContent = 'Describe it first.'; return }
  $('coverOptimize').disabled = true; $('coverOptStatus').textContent = 'Claude is writing the prompt…'
  try {
    const r = await fetch('/api/image-prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description, kind: 'cover' }) })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { $('coverOptStatus').textContent = data.error || ('Error ' + r.status); return }
    $('coverPrompt').value = (data.prompt || '').trim()
    $('coverOptStatus').textContent = 'Prompt ready — tweak it or Generate.'
  } catch (e) {
    $('coverOptStatus').textContent = 'Request failed — is the server running? ' + e.message
  } finally { $('coverOptimize').disabled = false }
}
async function editCover () {
  if (!coverData) { $('coverEditStatus').textContent = 'Generate or open an image first.'; return }
  const instr = $('coverEditInstr').value.trim()
  if (!instr) { $('coverEditStatus').textContent = 'Describe the change first.'; return }
  $('coverEdit').disabled = true; $('coverEditStatus').textContent = 'Editing this image… (can take 20–40s)'
  try {
    const r = await fetch('/api/image', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: instr, image: coverData }) })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { $('coverEditStatus').textContent = data.error || ('Error ' + r.status); return }
    coverData = data.dataUrl; $('coverImg').src = coverData
    $('coverEditInstr').value = ''; $('coverEditStatus').textContent = 'Edited — Use/Download, or refine again.'
  } catch (e) {
    $('coverEditStatus').textContent = 'Request failed — is the server running? ' + e.message
  } finally { $('coverEdit').disabled = false }
}
$('coverOptimize').onclick = optimizeCoverPrompt
$('coverEdit').onclick = editCover
$('btnCover').onclick = openCover
$('coverClose').onclick = closeCover
$('coverModal').addEventListener('click', e => { if (e.target === $('coverModal')) closeCover() })
$('coverGen').onclick = generateCover
$('coverUse').onclick = useCover
$('coverDownload').onclick = downloadCover
$('coverOpen').onclick = () => $('coverFile').click()
$('coverFile').onchange = e => {
  const f = e.target.files[0]; if (!f) return
  const rd = new FileReader()
  rd.onload = () => { coverData = rd.result; $('coverImg').src = coverData; $('coverResult').hidden = false; $('coverStatus').textContent = 'Image loaded — refine it below, or use/download.' }
  rd.readAsDataURL(f); e.target.value = ''
}

renderProjects()
renderChapters(); renderEditor()
recordNow() // seed history with the loaded state

// Default to WYSIWYG mode; "Advanced" = Markdown source. Remember the user's last choice.
setModeButtons()
updateCoverButton()
if ((localStorage.getItem(MODEKEY) || 'rich') !== 'md') enterRich()
