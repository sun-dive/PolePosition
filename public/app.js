/* Pole Position — Phase 1 editor: chapters + Markdown + live preview + localStorage autosave.
   (Phase 2 adds Claude writing assist, Phase 3 fal images + cover, Phase 4 EPUB export, Phase 5 mint.) */
const KEY = 'polepos:draft'
const MODEKEY = 'polepos:mode' // 'rich' (default, visual) | 'md' (advanced, Markdown source)
const $ = id => document.getElementById(id)
const uid = () => 'c' + Math.random().toString(36).slice(2, 9)

function blank () {
  return { title: '', author: '', activeId: null, chapters: [{ id: uid(), title: 'Chapter 1', body: '' }] }
}
function load () {
  try { const b = JSON.parse(localStorage.getItem(KEY)); if (b && Array.isArray(b.chapters) && b.chapters.length) return b } catch {}
  return blank()
}
let book = load()
if (!book.activeId || !book.chapters.some(c => c.id === book.activeId)) book.activeId = book.chapters[0].id

let saveTimer = null
function save () {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(book)); flash('Saved') } catch { flash('Could not save (storage full?)') }
  }, 350)
}
function flash (msg) { $('status').textContent = msg; }

const active = () => book.chapters.find(c => c.id === book.activeId)

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
      renderChapters(); refreshEditorView(); save(); recordNow(); flash('Imported draft.')
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
function setRichButton () {
  const b = $('btnRich')
  if (richMode) { b.textContent = '⚙ Advanced — Edit MD source'; b.title = 'Advanced: edit the raw Markdown source' }
  else { b.textContent = '✨ WYSIWYG'; b.title = 'Switch to visual (WYSIWYG) editing' }
}
async function enterRich () {
  if (!window.PPMilkdown) { flash('Rich editor isn’t loaded — run “npm run build:editor”. Using Markdown for now.'); setRichButton(); return }
  richBusy = true; richMode = true
  document.body.classList.add('rich-mode'); setRichButton()
  try {
    await mountRich()
    try { localStorage.setItem(MODEKEY, 'rich') } catch {}
    flash('Rich editing — your Markdown is saved underneath.')
  } catch (e) {
    richMode = false; document.body.classList.remove('rich-mode'); setRichButton()
    flash('Rich editor failed to start: ' + e.message)
  } finally { richBusy = false }
}
async function exitRich () {
  richBusy = true
  flushRich()
  await window.PPMilkdown.destroy()
  richMode = false; document.body.classList.remove('rich-mode'); setRichButton()
  try { localStorage.setItem(MODEKEY, 'md') } catch {}
  renderEditor(); save(); richBusy = false
}
async function toggleRich () { if (richBusy) return; if (richMode) await exitRich(); else await enterRich() }
$('btnRich').onclick = toggleRich

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
  try { localStorage.setItem(KEY, JSON.stringify(book)) } catch {}
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
$('btnUndo').onclick = undo
$('btnRedo').onclick = redo
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey)) return
  const k = e.key.toLowerCase()
  if (richMode) return // let Milkdown handle its own granular undo in Rich mode
  if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo() }
  else if (k === 'y') { e.preventDefault(); redo() }
})

renderChapters(); renderEditor()
recordNow() // seed history with the loaded state

// Default to Rich (visual) mode; "Advanced" = Markdown source. Remember the user's last choice.
setRichButton()
if ((localStorage.getItem(MODEKEY) || 'rich') !== 'md') enterRich()
