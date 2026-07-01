# 🏁 Pole Position

A local-first studio for creating on-chain NFT releases — **ebooks and music/media** — that mint to a SMART NFT (via the Phar Lap engine). Write and illustrate a book with an AI co-author, or prep a music/video release (covers, animations, a music-video cue, synced lyrics, lossless audio), then publish it on-chain.

## Run

```
npm install
node server.mjs
```

Open **http://localhost:4321**. Drafts autosave in your browser; **Export draft** saves a `.json` backup. The app runs a local Node server and only ever talks to `localhost`.

## AI writing

Runs on your own Claude via the **Claude Agent SDK** — **no API key is needed or stored**, and the browser only ever talks to `localhost`. Optionally set `CLAUDE_MODEL` in a local `.env`.

- **Write / Continue / Rewrite / Outline** assists on the current chapter, with an optional *whole-book context* toggle so new writing stays consistent with the rest of the book.
- **Draft from brief** — a "Book Factory": one line → Claude designs a title + chapter outline (editable), then drafts every chapter into a new book.
- Multi-book projects switcher, duplicate a book, WYSIWYG / Markdown-source editing, undo/redo, autosave.

## Images & covers

AI images use **fal.ai** with its own `FAL_API_KEY` (in a local `.env`); Claude writes the optimized image prompt on your subscription first.

- **🎨 Cover** — describe it → Claude optimizes the prompt → nano-banana generates. Portrait 2:3 (book) or Square 1:1 (music). Refine in place (nano-banana edit, keeps the composition), open an image from disk, or **Animate** a still into a short looping cover (fal image-to-video → animated WebP/GIF via ffmpeg).
- **🖼️ Chapter art** — a per-book house style (with templates) for consistent illustrations, generate/edit/insert into the chapter, plus a 1344×768 banner-JPEG export.

## Media production (for music/video releases)

- **🎬 Sequence builder** — concatenate animated clips (add clip ×N, in order) into one looping cover, at a chosen frame rate to shrink the file. Live **loop-duration + estimated file-size** readouts so scene repeats can be synced to music. Built server-side with ImageMagick.
- **🎞️ Music video builder** — author a scene timeline: a **scene library** (each clip stored once) plus a timeline of placements you can **reuse** and **reorder (↑/↓)**. Scrub the song and stamp each placement's time to produce a `video.cue` (timestamps → scene images). Download a **project bundle** (`.zip`: scenes + song + cue), and restore later via **Load bundle** or **Load cue**.
- **🎤 Lyrics builder** — a tap-along `.lrc` timeline maker: load the song, paste lyrics, then play and tap ⏱ (or the **Space bar**) at the start of each line to time it. Auto-scrolls the armed line into view; export `.lrc` (synced) or plain text. Load an existing `.lrc` to re-time.
- **🎚️ WAV→FLAC encoder** — lossless, maximum compression, encoded server-side with `flac --best --verify` (bit-exact, ~half the size) for minting.

## Export & publish

- **📚 EPUB** and **📄 PDF** export of the assembled book (cover + chapters, images embedded).
- Media bundles (FLAC, cover/animation, `video.cue`, `.lrc`) are downloaded ready to embed (e.g. in Kid3) and **mint on-chain in PharLap**.

## Requirements

- **Node** (for the server + AI writing).
- **fal.ai** — a `FAL_API_KEY` in a local `.env` for image / animation generation.
- **ffmpeg** — for cover animation (WebP/GIF conversion).
- **ImageMagick** (`magick`) — for the sequence / looping-cover builder.
- **flac** — for the WAV→FLAC encoder.

## Status

Evolving, and broader than an ebook tool. Shipped today: the chapter editor + AI writing (Book Factory, whole-book context), AI covers/chapter art (generate/edit/animate), the sequence, music-video (scene-timeline → cue + bundle), lyrics, and WAV→FLAC media tooling, plus EPUB/PDF export. On-chain publishing happens by minting the exported assets in **PharLap** (an integrated in-app mint handoff is still to come).

## License
© 2026 sun-dive. Licensed under the **Open BSV License Version 6** — see [LICENSE](./LICENSE). © BSV Association. The software, and anything derived from it, **may only be used on the BSV Blockchain**.
