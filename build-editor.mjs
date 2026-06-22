// Bundles web/editor.js (Milkdown Crepe + its CSS) → public/editor.bundle.js (+ .css).
// Run:  npm run build:editor
import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['web/editor.js'],
  bundle: true,
  format: 'iife',
  outfile: 'public/editor.bundle.js',
  minify: true,
  sourcemap: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: {
    '.svg': 'dataurl', '.png': 'dataurl',
    '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.eot': 'dataurl'
  },
  logLevel: 'info'
})

console.log('✓ built public/editor.bundle.js (+ .css)')
