/* Pole Position — Rich (WYSIWYG) editing, bundled to public/editor.bundle.js by build-editor.mjs.
   Wraps Milkdown's Crepe editor and exposes a tiny global API the vanilla app.js drives.
   Markdown stays the canonical format: mount(md) → edit visually → getMarkdown() returns clean MD. */
import { Crepe } from '@milkdown/crepe'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/nord-dark.css'

let crepe = null

window.PPMilkdown = {
  /** Create the rich editor inside `el`, seeded with `markdown`. `onChange(md)` fires on every edit. */
  async mount (el, markdown, onChange) {
    await this.destroy()
    crepe = new Crepe({ root: el, defaultValue: markdown || '' })
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
