# 🎥 Video → WebP — help

Turn a short video clip into a small **looping animated WebP** you can mint on-chain. Use it to drop
brief live-action cutaways into an otherwise still-image "pseudo video," alongside your fal.ai clips —
keeping every piece in the same low byte range.

Menubar: **🎥 Video→WebP**.

---

## Workflow

1. **Trim the clip** in a video editor (e.g. Kdenlive) and **export an MP4**. Keep it *short* — length is the
   single biggest driver of file size.
2. Open **🎥 Video→WebP**, choose the file, set the options, and click **Make WebP loop**.
3. Check the size readout, adjust if needed, then **Download** → mint the `.webp` in PharLap.

The result loops forever (`-loop 0`) with no audio — the same format as the fal image-to-video clips.

---

## Options

| Option | Choices | Notes |
|---|---|---|
| **Shape** | 16:9 (wide) · 1:1 (square) | Center **cover-crop**: fills the frame and trims overflow. A 16:9 source stays untouched in 16:9 mode; in 1:1 mode it's cropped to a square — so **keep your subject centered**. |
| **Frame rate** | 15 · 7 · 5 fps | Matches the fal framerate options. Lower = smaller. |
| **Width** | 320 · 384 · 480 · 512 · 640 px | Height follows the shape. Area scales with the square of width. |
| **Quality** | 40 · 55 · 70 | libwebp quality (higher = sharper + bigger). |

After each build the tool reports: **W×H · fps · frames · duration · file size**, and warns if the result is
over ~3 MB (too large for comfortable on-chain minting).

---

## Export resolution — does it matter?

**No.** The tool always downscales to the width you pick (320–640px) with a high-quality lanczos filter, so
it discards any extra resolution. A 4K source and a 1080p source produce a near-identical 480px WebP.

So **downsize on export** — 1080p (even 720p) is plenty, and it's faster, smaller, and stays well under the
400 MB upload cap. What *does* carry through:

- **Aspect ratio** — export in the shape you intend (16:9, or crop to square in the editor). Mismatched shape
  gets cover-cropped.
- **Bitrate / export quality** — heavy compression artifacts in the source MP4 survive into the WebP. Lower
  *resolution* is fine; a low-*bitrate*, blocky export is not. A normal-quality 1080p export is ideal.
- **Frame rate** — export at normal (24/30 fps); the tool drops it to your chosen 5/7/15. No need to
  pre-lower it.

---

## Staying small — matching the fal clip byte count

Live footage is **busier** than fal's clips (film grain, fine texture, camera motion), so **at identical
settings a live-action WebP comes out bigger than a fal one.** To land at the same byte count, live clips
should lean a notch smaller.

**Good starting preset for accent clips:** `480px · 7 fps · quality 50 · 2–3 s`.
(For reference, the fal clips in the **Sequence** tool are encoded at `512px · 15 fps · q70` — live footage at
those exact settings will overshoot, which is why live clips start smaller.)

**The levers, ranked by how much they cut size:**

1. **Duration** (trim in Kdenlive) — linear: half the length ≈ half the bytes. Biggest, cheapest win.
2. **Frame rate** — 15 → 7 ≈ half; 7 → 5 trims a bit more.
3. **Width** — area scales with the square, so 480 → 320 is ~2.25× fewer pixels.
4. **Quality** — 70 → 40 trims the rest.

**Don't guess — use the readout.** Note what one of your fal clips weighs, then dial a live clip to match:
build, read the KB, nudge a setting, re-run. It's a fast local convert, so hitting the target number takes
seconds.

---

## Under the hood

- Endpoint: `POST /api/video-webp?aspect=16:9|1:1&fps=15|7|5&width=<96..1024>&q=<1..100>`; raw request body is
  the video file.
- ffmpeg filter: `fps=<fps>,scale=<W>:<H>:force_original_aspect_ratio=increase:flags=lanczos,crop=<W>:<H>`
  encoded with `-vcodec libwebp -loop 0 -lossless 0 -q:v <q> -compression_level 6 -an`.
- Requires **ffmpeg** (with libwebp) and **ImageMagick** (`magick`, for the frame count) on the host — the same
  tools the Sequence and Tag features already use.
- **Server change:** adding/altering this endpoint needs a **server restart** (`npm run electron` / `node
  server.mjs`); a window reload alone won't pick it up.
