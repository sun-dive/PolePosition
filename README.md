# 🏁 Pole Position

A local-first studio for **creating on-chain media** — ebooks and music/video releases — that mint to a **SMART NFT** through the [Phar Lap](https://smartnfts.com) engine. Write and illustrate a book with an AI co-author, or produce a music/video release (covers, animated loops, a **Block Media Format** music-video, synced lyrics, lossless audio), then reuse on-chain components across new work. Create it, mint it, reuse it — **owned, not claimed**.

Pole Position is the **create** corner of the trinity: **[Phar Lap](https://smartnfts.com)** (own/mint) · **[Big Red](https://nft.sale)** (sell) · **Pole Position** (create).

## Block Media Format (BMF & BMC)

Pole Position is the authoring tool for **Block Media Format** — an open format for composable, on-chain-native video ([spec](https://github.com/sun-dive/block-media-format), proposed [BRC-145](https://github.com/bsv-blockchain/BRCs/pull/177)):

- A **`.bmf`** manifest expresses a video not as one opaque file but as a small **timeline of media references** — each scene/loop minted once on-chain, provenanced, and reusable many times. No new codec: it carries standard WebP/FLAC/MP3.
- A **`.bmc`** container bundles a `.bmf` with its media (or a **set** of independently-addressable atoms) into one portable, mintable file.

So a "music video" becomes a few kilobytes of manifest plus a handful of reusable on-chain loops — store once, reference many.

## Run

```
npm install
npm start          # local web app → http://localhost:4321
# or: npm run electron   (packaged desktop app)
```

Drafts autosave in your browser; **Export draft** saves a `.json` backup. The app runs a local Node server and only ever talks to `localhost`.

## AI writing

Runs on your own Claude via the **Claude Agent SDK** — **no API key is needed or stored**; the browser only talks to `localhost`. Optionally set `CLAUDE_MODEL` in a local `.env`.

- **Write / Continue / Rewrite / Outline** on the current chapter, with an optional *whole-book context* toggle so new writing stays consistent.
- **Draft from brief** — a "Book Factory": one line → Claude designs a title + editable chapter outline, then drafts every chapter.
- Multi-book switcher, duplicate a book, WYSIWYG / Markdown editing, undo/redo, autosave.

## Images & covers

AI images use **fal.ai** (its own `FAL_API_KEY` in a local `.env`); Claude writes the optimized prompt on your subscription first.

- **🎨 Cover** — describe it → generate (nano-banana), portrait 2:3 (book) or square 1:1 (music). Refine in place, open from disk, or **🎬 Animate** a still into a short looping cover.
- **🖼️ Chapter art** — a per-book house style for consistent illustrations, plus a banner-JPEG export.

## Media production — Block Media Format authoring

- **🎞️ Music video** — author a scene timeline: a **scene library** (each loop stored once) plus reorderable placements you scrub-and-stamp against the song. **⛓ Export .bmf** — the on-chain manifest referencing each component by `{tx, name}`.
- **📦 BMC set** — bundle several BMF loops into one **`.bmc` set** (📦 Export .bmc), so a whole set of independently-referenceable atoms mints as one collection.
- **🎥 Video → looping WebP / MP4** — turn a video/WebP into a tempo-locked looping cover: **lossless centre-crop** (best quality, smallest on-chain footprint), a watermark picker, multi-file join, and a CFR-H.264 **MP4 export** for editors that mishandle animated-WebP VFR.
- **🎬 Sequence** — concatenate animated clips into one looping cover at a chosen frame rate, with live loop-duration + file-size readouts to sync repeats to the music.
- **🎤 Lyrics** — a tap-along `.lrc` timeline maker (play, tap the Space bar per line); export synced `.lrc` or plain text.
- **🎚️ WAV → FLAC** — lossless, maximum-compression encode (`flac --best --verify`, bit-exact) for minting.

## Import & reuse (create → mint → reuse)

The loop closes on-chain: mint a release in Phar Lap, then pull its components back in to build the next one.

- **⛓ Import from mint** — paste a share link or txid (any creator's) → fetch, decrypt (Tier-1 keyless), and verify the on-chain atom, then drop it into your timeline. Reused atoms are referenced by `{tx, name}`, never re-uploaded.
- **🔍 My atoms** — set a wallet address / pubkey per project and browse everything that creator has published on-chain, ready to reuse.
- **Reuse-aware bundle** — the exported `.bmf`/`.bmc` skips re-minting components that already live on-chain.
- **Local atom cache** — content is immutable (txid = content), so fetched atoms are cached on disk and never reloaded. Legacy **MPT-FILE / P-FILE** plaintext atoms decode too.

## Export & publish

- **📚 EPUB** / **📄 PDF** of the assembled book (cover + chapters, images embedded).
- **`.bmf` / `.bmc`** media bundles, plus FLAC / cover / `.lrc`, downloaded ready to **mint on-chain in [Phar Lap](https://smartnfts.com)** (an in-app mint handoff is still to come — minting happens in Phar Lap today).

## Requirements

- **Node** — server + AI writing. **fal.ai** `FAL_API_KEY` — image/animation. **ffmpeg** — WebP/MP4 conversion. **ImageMagick** (`magick`) — looping-cover / crop / watermark. **flac** — WAV→FLAC.

## Ecosystem

- **[Phar Lap](https://smartnfts.com)** — the SMART NFT wallet + covenant mint engine ([repo](https://github.com/sun-dive/PharLap)).
- **[Big Red](https://nft.sale)** — the SMART NFT sales ring / resale catalog ([repo](https://github.com/sun-dive/BigRed)).
- **[Block Media Format](https://github.com/sun-dive/block-media-format)** — the open BMF/BMC spec ([`docs/BMF-SPEC.md`](./docs/BMF-SPEC.md), proposed BRC-145).

## Status

Evolving, and broader than an ebook tool. Shipped: the chapter editor + AI writing (Book Factory, whole-book context); AI covers/chapter art (generate/edit/animate); the full media suite (Music video → `.bmf`, BMC sets, Video→WebP with lossless crop + watermark + MP4, Sequence, Lyrics, WAV→FLAC); import-from-mint + atom reuse (creator catalog, reuse-aware bundle, atom cache, legacy decode); and EPUB/PDF export. On-chain minting happens by publishing the exported assets in **Phar Lap**.

## License

© 2026 sun-dive. Licensed under the **Open BSV License Version 6** — see [LICENSE](./LICENSE). © BSV Association. The software, and anything derived from it, **may only be used on the BSV Blockchain**.
