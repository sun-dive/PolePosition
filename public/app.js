/* Pole Position — Phase 1 editor: chapters + Markdown + live preview + localStorage autosave.
   (Phase 2 adds Claude writing assist, Phase 3 fal images + cover, Phase 4 EPUB export, Phase 5 mint.) */
const KEY = 'polepos:draft'
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

/* ---- minimal Markdown → HTML (headings, bold, italic, links, lists, hr) ---- */
function md (src) {
  const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  const inline = s => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  let html = '', inList = false
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    const li = line.match(/^[-*]\s+(.*)$/)
    if (li) { if (!inList) { html += '<ul>'; inList = true } html += `<li>${inline(li[1])}</li>`; continue }
    if (inList) { html += '</ul>'; inList = false }
    if (h) html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`
    else if (/^---+$/.test(line)) html += '<hr>'
    else if (line !== '') html += `<p>${inline(line)}</p>`
  }
  if (inList) html += '</ul>'
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
function selectChapter (id) { book.activeId = id; renderChapters(); renderEditor(); save() }
function addChapter () {
  const c = { id: uid(), title: `Chapter ${book.chapters.length + 1}`, body: '' }
  book.chapters.push(c); book.activeId = c.id; renderChapters(); renderEditor(); save()
}
function deleteChapter (id) {
  if (book.chapters.length === 1) { flash('A book needs at least one chapter.'); return }
  if (!confirm('Delete this chapter?')) return
  const i = book.chapters.findIndex(c => c.id === id)
  book.chapters.splice(i, 1)
  if (book.activeId === id) book.activeId = book.chapters[Math.max(0, i - 1)].id
  renderChapters(); renderEditor(); save()
}
function moveChapter (i, dir) {
  const j = i + dir
  if (j < 0 || j >= book.chapters.length) return
  ;[book.chapters[i], book.chapters[j]] = [book.chapters[j], book.chapters[i]]
  renderChapters(); save()
}

function exportDraft () {
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
      book = b; if (!book.chapters.some(c => c.id === book.activeId)) book.activeId = book.chapters[0].id
      $('bookTitle').value = book.title || ''; $('bookAuthor').value = book.author || ''
      renderChapters(); renderEditor(); save(); flash('Imported draft.')
    } catch { flash('That file isn’t a valid Pole Position draft.') }
  }
  r.readAsText(file)
}

/* ---- wire up ---- */
$('bookTitle').value = book.title || ''
$('bookAuthor').value = book.author || ''
$('bookTitle').oninput = e => { book.title = e.target.value; save() }
$('bookAuthor').oninput = e => { book.author = e.target.value; save() }
$('chapterTitle').oninput = e => { active().title = e.target.value; renderChapters(); save() }
$('chapterBody').oninput = e => { active().body = e.target.value; renderPreview(); save() }
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
  const body = $('chapterBody')
  aiSel = { start: body.selectionStart, end: body.selectionEnd }
  const selection = body.value.slice(aiSel.start, aiSel.end)
  if (mode === 'rewrite' && !selection.trim()) { flash('Select some text in the editor to rewrite first.'); return }
  setAiBusy(true); flash('Writing…')
  try {
    const r = await fetch('/api/write', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, instruction: $('aiPrompt').value.trim(), chapterText: body.value, selection, title: book.title, author: book.author })
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
  const body = $('chapterBody'); const v = body.value
  const before = v.slice(0, start), after = v.slice(end)
  const sep = before && !before.endsWith('\n') ? '\n\n' : ''
  body.value = before + sep + text + after
  active().body = body.value
  const pos = (before + sep + text).length
  body.focus(); body.setSelectionRange(pos, pos)
  renderPreview(); save(); hideAiResult(); flash('Inserted.')
}

$('aiDraft').onclick = () => aiGenerate('draft')
$('aiContinue').onclick = () => aiGenerate('continue')
$('aiRewrite').onclick = () => aiGenerate('rewrite')
$('aiOutline').onclick = () => aiGenerate('outline')
$('aiInsert').onclick = () => applyText(aiSel.start, aiSel.start, aiResult)
$('aiReplace').onclick = () => applyText(aiSel.start, aiSel.end, aiResult)
$('aiAppend').onclick = () => { const b = $('chapterBody'); applyText(b.value.length, b.value.length, aiResult) }
$('aiDiscard').onclick = () => { hideAiResult(); flash('Discarded.') }

renderChapters(); renderEditor()
