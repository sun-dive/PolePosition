// epub.mjs — build a valid EPUB 3 from a Pole Position book, with zero external deps.
// Markdown → XHTML (matches the editor's md()), embeds the cover (data URL) + inline art
// (public/art files referenced as art/<file>), and packs a spec-correct zip (mimetype stored first).
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { createHash } from 'node:crypto'

/* ---------- zip (mimetype must be the first entry, stored uncompressed) ---------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
function crc32 (buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0 }
function zip (entries) {
  const out = [], central = []; let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), crc = crc32(e.data)
    const method = e.store ? 0 : 8
    const comp = e.store ? e.data : deflateRawSync(e.data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28)
    out.push(lh, name, comp)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(method, 10)
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(e.data.length, 24)
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36)
    ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42)
    central.push(ch, name)
    offset += lh.length + name.length + comp.length
  }
  const cdStart = offset; let cdSize = 0; for (const c of central) cdSize += c.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(cdStart, 16); eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...out, ...central, eocd])
}

/* ---------- markdown → XHTML ---------- */
const xesc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const attr = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
function inlineX (s, imgMap) {
  return xesc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => { let r = src; if (imgMap.has(src)) { r = imgMap.get(src); if (!r) return '' } return `<img alt="${attr(alt)}" src="${attr(r)}"/>` })
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, h) => `<a href="${attr(h)}">${t}</a>`)
}
function bodyToXhtml (src, imgMap) {
  let html = '', list = null, inQuote = false
  const closeList = () => { if (list) { html += list === 'ol' ? '</ol>' : '</ul>'; list = null } }
  const closeQuote = () => { if (inQuote) { html += '</blockquote>'; inQuote = false } }
  for (const raw of String(src).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    const h = line.match(/^(#{1,6})\s+(.*)$/), uli = line.match(/^[-*]\s+(.*)$/), oli = line.match(/^\d+\.\s+(.*)$/), q = line.match(/^>\s?(.*)$/)
    if (uli) { closeQuote(); if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul' } html += `<li>${inlineX(uli[1], imgMap)}</li>`; continue }
    if (oli) { closeQuote(); if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol' } html += `<li>${inlineX(oli[1], imgMap)}</li>`; continue }
    closeList()
    if (q) { if (!inQuote) { html += '<blockquote>'; inQuote = true } html += `<p>${inlineX(q[1], imgMap)}</p>`; continue }
    closeQuote()
    if (h) html += `<h${h[1].length}>${inlineX(h[2], imgMap)}</h${h[1].length}>`
    else if (/^---+$/.test(line)) html += '<hr/>'
    else if (line !== '') html += `<p>${inlineX(line, imgMap)}</p>`
  }
  closeList(); closeQuote()
  return html || '<p></p>'
}

const xhtmlDoc = (title, bodyInner, bodyClass = '') =>
  `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">\n<head><meta charset="utf-8"/><title>${xesc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>\n<body${bodyClass ? ` class="${bodyClass}"` : ''}>${bodyInner}</body>\n</html>`

const CSS = `body{font-family:Georgia,serif;line-height:1.6;margin:5% 6%;color:#1a1a1a}
h1,h2,h3,h4{line-height:1.25;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
h1{font-size:1.7em}h2{font-size:1.4em}img{max-width:100%;height:auto;display:block;margin:1em auto;border-radius:6px}
blockquote{margin:1em 0;padding:.2em 1em;border-left:3px solid #ccc;color:#555}
a{color:#1a5fb4}hr{border:0;border-top:1px solid #ccc;margin:1.5em 0}
body.cover{margin:0;text-align:center}body.cover img{max-width:100%;max-height:100vh;margin:0;border-radius:0}`

function bookId (book) {
  const h = createHash('sha1').update((book.title || '') + '|' + (book.author || '')).digest('hex')
  return `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/* ---------- build ---------- */
export async function buildEpub (book, { artDir, modified } = {}) {
  const title = book.title || 'Untitled', author = book.author || ''
  const images = [], seen = new Map() // src(art/..) -> epub href (or null if missing)

  // cover from data URL
  let coverHref = null, coverMedia = null
  const cm = typeof book.cover === 'string' && book.cover.match(/^data:image\/([a-z0-9.+-]+);base64,(.+)$/i)
  if (cm) {
    const ext = cm[1].toLowerCase().replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '')
    coverHref = 'images/cover.' + ext; coverMedia = 'image/' + (ext === 'jpg' ? 'jpeg' : ext)
    images.push({ href: coverHref, data: Buffer.from(cm[2], 'base64'), media: coverMedia, id: 'cover-image', isCover: true })
  }

  // gather inline art referenced as art/<file>
  for (const c of book.chapters) {
    const re = /!\[[^\]]*\]\((art\/[^)]+)\)/g; let m
    while ((m = re.exec(c.body || ''))) {
      const src = m[1]; if (seen.has(src)) continue
      const file = join(artDir || '', basename(src))
      if (artDir && existsSync(file)) {
        const ext = (basename(src).split('.').pop() || 'png').toLowerCase()
        const href = 'images/' + basename(src)
        const media = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png'
        images.push({ href, data: await readFile(file), media, id: 'img-' + images.length })
        seen.set(src, href)
      } else seen.set(src, null)
    }
  }

  // chapter docs
  const chapters = book.chapters.map((c, i) => ({
    id: 'chap' + (i + 1), href: 'chap' + (i + 1) + '.xhtml',
    title: c.title || ('Chapter ' + (i + 1)),
    xhtml: xhtmlDoc(c.title || ('Chapter ' + (i + 1)), bodyToXhtml(c.body || '', seen))
  }))

  const coverDoc = coverHref ? xhtmlDoc('Cover', `<img src="${coverHref}" alt="${attr(title)}"/>`, 'cover') : null

  // content.opf
  const manifest = []
  manifest.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>')
  manifest.push('<item id="css" href="style.css" media-type="text/css"/>')
  if (coverDoc) manifest.push('<item id="coverpage" href="cover.xhtml" media-type="application/xhtml+xml"/>')
  for (const c of chapters) manifest.push(`<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`)
  for (const im of images) manifest.push(`<item id="${im.id}" href="${im.href}" media-type="${im.media}"${im.isCover ? ' properties="cover-image"' : ''}/>`)
  const spine = []
  if (coverDoc) spine.push('<itemref idref="coverpage"/>')
  for (const c of chapters) spine.push(`<itemref idref="${c.id}"/>`)
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${bookId(book)}</dc:identifier>
    <dc:title>${xesc(title)}</dc:title>
    <dc:language>en</dc:language>${author ? `\n    <dc:creator>${xesc(author)}</dc:creator>` : ''}
    <meta property="dcterms:modified">${(modified || '2026-01-01T00:00:00Z').replace(/\.\d+Z$/, 'Z')}</meta>${coverHref ? '\n    <meta name="cover" content="cover-image"/>' : ''}
  </metadata>
  <manifest>
    ${manifest.join('\n    ')}
  </manifest>
  <spine>
    ${spine.join('\n    ')}
  </spine>
</package>`

  const navItems = chapters.map(c => `      <li><a href="${c.href}">${xesc(c.title)}</a></li>`).join('\n')
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head><meta charset="utf-8"/><title>${xesc(title)}</title></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>\n${navItems}\n    </ol></nav></body>
</html>`

  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

  // assemble zip (mimetype FIRST, stored)
  const entries = [
    { name: 'mimetype', data: Buffer.from('application/epub+zip'), store: true },
    { name: 'META-INF/container.xml', data: Buffer.from(container, 'utf8') },
    { name: 'OEBPS/content.opf', data: Buffer.from(opf, 'utf8') },
    { name: 'OEBPS/nav.xhtml', data: Buffer.from(nav, 'utf8') },
    { name: 'OEBPS/style.css', data: Buffer.from(CSS, 'utf8') }
  ]
  if (coverDoc) entries.push({ name: 'OEBPS/cover.xhtml', data: Buffer.from(coverDoc, 'utf8') })
  for (const c of chapters) entries.push({ name: 'OEBPS/' + c.href, data: Buffer.from(c.xhtml, 'utf8') })
  for (const im of images) entries.push({ name: 'OEBPS/' + im.href, data: im.data })
  return zip(entries)
}
