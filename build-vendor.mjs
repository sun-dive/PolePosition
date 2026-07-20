// Bundles the vendored PharLap decoders (TypeScript, + @bsv/sdk) → a single self-contained plain-JS ESM file
// that runs in Electron's Node WITHOUT any runtime TypeScript stripping. Run:  npm run build:vendor
import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['vendor/pharlap/bmf-import.mjs'], // imports the vendored .ts decoders + @bsv/sdk
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: 'vendor/pharlap/bmf-import.bundle.mjs', // @bsv/sdk inlined → no runtime dependency, asar-safe
  logLevel: 'info'
})

console.log('✓ built vendor/pharlap/bmf-import.bundle.mjs (self-contained, Electron-ready)')
