/* Pole Position — Rich (WYSIWYG) editing, bundled to public/editor.bundle.js by build-editor.mjs.
   Wraps Milkdown's Crepe editor and exposes a tiny global API the vanilla app.js drives.
   Markdown stays the canonical format: mount(md) → edit visually → getMarkdown() returns clean MD. */
import { Crepe } from '@milkdown/crepe'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/nord-dark.css'

let crepe = null

/** Read a File as a data URL (base64) in the browser. */
function readAsDataURL (file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = () => reject(new Error('could not read image'))
    fr.readAsDataURL(file)
  })
}

/** Persist a dropped / pasted / uploaded image to the server (public/art) and return its stable `art/…` URL.
 *  THIS is the fix for drag-drop: without it Crepe uses a temporary `blob:` URL that dies on reload (which is
 *  what left broken pictures in earlier drafts). Falls back to an inline data URL — self-contained, so it still
 *  survives a reload — only if the save endpoint is unreachable. Never returns a blob: URL. */
async function uploadImage (file) {
  const dataUrl = await readAsDataURL(file)
  try {
    const r = await fetch('/api/save-image', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataUrl }),
    })
    const d = await r.json().catch(() => ({}))
    if (r.ok && d.url) return d.url // e.g. 'art/art-xxxx.png' — a real file in public/art, survives reload
  } catch { /* fall through to the inline fallback */ }
  return dataUrl
}

window.PPMilkdown = {
  /** Create the rich editor inside `el`, seeded with `markdown`. `onChange(md)` fires on every edit. */
  async mount (el, markdown, onChange) {
    await this.destroy()
    crepe = new Crepe({
      root: el,
      defaultValue: markdown || '',
      featureConfigs: {
        // Save dropped / pasted / uploaded images to public/art (stable art/ links) — not blob: URLs.
        [Crepe.Feature.ImageBlock]: {
          onUpload: uploadImage,
          blockOnUpload: uploadImage,
          inlineOnUpload: uploadImage,
        },
      },
    })
    if (onChange) {
      crepe.on(listener => {
        listener.markdownUpdated((_ctx, md) => { try { onChange(md) } catch {} })
      })
    }
    await crepe.create()
    return true
  },
  /** Current document as Markdown (null if not mounted). */
  getMarkdown () {
    try { return crepe ? crepe.getMarkdown() : null } catch { return null }
  },
  /** Tear down the editor and free the DOM. */
  async destroy () {
    if (crepe) { try { await crepe.destroy() } catch {} crepe = null }
  }
}
