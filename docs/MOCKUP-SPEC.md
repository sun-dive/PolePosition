# Mockup Prop Atoms & Cover Manifests

*Draft v0.1 — a BMF-family format for composing product covers on-chain. See [BMF-SPEC.md](BMF-SPEC.md).*

A product cover (a design shown on a tee, mug, tote, poster…) is not stored as a baked image. It is a
**recipe**: a reusable **prop atom** + a **design** + a few placement numbers, composited in the browser. Same
"reference, don't embed" spine as BMF — a mug photo is minted once and drives thousands of covers.

Three pieces:

| Piece | What | On-chain form |
|---|---|---|
| **Prop atom** | the blank product + its surface maps | a `.bmc` (ZIP), minted once, shared |
| **Design** | the artwork — the **watermarked public preview** (the clean file stays encrypted) | an atom (txid) |
| **Cover manifest** | the recipe binding prop + design + placement | a **packed byte record** (≈66–90 B) |

The clean product is never referenced by a public cover — only the watermarked preview is (see Phase 3 security).

---

## 1. Geometry model — two stages

Keeping these separate is what makes one small warp registry cover mugs, shirts and angled flats:

1. **Surface warp** (design-local): shapes the flat design to the *surface* — a mug's curve, a shirt's folds —
   in a plain rectangle. An ordered, extensible **warp pipeline** (§3).
2. **Quad placement** (onto the base): maps that warped rectangle onto a 4-corner **print region** on the base
   photo — this alone carries position, scale, rotation *and* planar perspective (an angled product).

Then **mask** (clip to the printable area) and **shading** (multiply the prop's own light over the design).

```
design → [warp pipeline] → [print-region quad] → [mask] → [× shading] → cover
```

---

## 2. Prop atom (`.bmc`)

A ZIP bundling the surface maps plus a small `prop` descriptor. Members are WebP (lossless where it matters);
the images dominate the atom's size, so they carry the byte budget — keep them tight (VFR/partial-frame WebP,
lossless centre-crop; see the project's on-chain-quality rules).

**Members (roles):**

| Role | Req. | What |
|---|---|---|
| `base` | ✔ | the blank product photo (shown behind/around the print) |
| `mask` | ○ | grayscale printable region (white = printable). Clips overflow. |
| `shade` | ○ | the multiply light/shadow map. If absent, derive from `base`. |
| `disp` | ○ | grayscale displacement map — only for `displace` warp (folds) |

**Descriptor** (`prop.json` while authoring; packed on-chain per §5):

```json
{
  "v": 1,
  "print": [[0.30,0.34],[0.66,0.34],[0.66,0.72],[0.30,0.72]],   // print-region quad, normalized base coords
  "warp":  [ { "t": "cyl", "curve": 0.62, "bow": 0.16 } ],       // default warp pipeline (§3)
  "roles": { "base": "mug.webp", "shade": "mug-shade.webp", "mask": "mug-mask.webp" },
  "meta":  { "name": "white-mug-11oz", "wmm": 200, "hmm": 93 }    // human label + print size (optional)
}
```

A prop declares its own default warp: a mug says `cyl`; a tee carries a `disp` map. Covers inherit it and rarely
override.

---

## 3. Warp pipeline (extensible)

`warp` is an **ordered array** of stages applied to the design in local space. New surfaces = new stage types;
nothing else changes. Empty array = flat. Stages compose (a tee can be `disp` *then* a gentle `cyl` for the body).

**The full registry is fixed here for future-proofing** — every id and its params are reserved now so any
implementation, present or future, agrees on the numbering. `●` = implemented today · `○` = spec'd, not yet built.

| id | `t` | Surface / use | ● | Params (name → packed byte) |
|---|---|---|:-:|---|
| 0 | `flat` | posters, stickers, flat-lay, labels | ● | — |
| 1 | `cyl` | mugs, cans, bottles, candles, tins | ● | `curve` 0–1→`u8/255` · `bow` −1..1→`i8/127` (sign=smile/frown) · `axis` `u8` 0=vert 1=horiz |
| 2 | `disp` | **t-shirts**, totes, hoodies, fabric, crumpled paper | ● | `str` 0–64px→`u8·0.25` · `map` `u8` role-id (default `disp`) |
| 3 | `persp` | angled planar skew beyond the print quad | ○ | `kx` `ky` −1..1→`i8/127` |
| 4 | `bulge` | pillows, balloons, badges, buttons, cushions | ○ | `amt` −1..1→`i8/127` (barrel/pincushion) |
| 5 | `sphere` | balls, globes, ornaments, domes, lenses | ○ | `curve` 0–1→`u8/255` |
| 6 | `cone` | tapered tumblers, lampshades, cups, buckets | ○ | `taper` 0–1→`u8/255` (top/bottom radius) · `curve` `u8/255` |
| 7 | `mesh` | arbitrary freeform surfaces (scanned props) | ○ | `cols` `u8` · `rows` `u8` · then cols×rows offsets (`i8`,`i8`), or `map` role-id |
| 8 | `ripple` | water, reflective surfaces, concentric | ○ | `amp` `u8` · `freq` `u8` · `phase` `u8` · `axis` `u8` |
| 9 | `wave` | hanging fabric, flags, banners, curtains | ○ | `amp` `u8` · `len` `u8` · `angle` `u8` (0–360) |
| 10 | `curl` | page/sticker curl, peeling corner | ○ | `amt` `u8` · `corner` `u8` (0–3 TL/TR/BR/BL) |
| 11 | `emboss` | engraving, letterpress, deboss, relief | ○ | `depth` −1..1→`i8/127` (uses `disp`/normal member) |
| 12 | `fold` | folded posters, maps, greeting cards | ○ | `n` `u8` lines, then per line: `angle` `u8` · `pos` `u8` · `sharp` `u8` |
| 13 | `skew` | quick affine shear | ○ | `sx` `sy` −1..1→`i8/127` |
| 14 | — | *reserved* (unused id kept open) | — | — |
| 15 | `ext` | escape hatch for anything beyond the table | — | `len` `u8`, then `len` raw param bytes |

*T-shirts* are the `disp` case: the prop's `disp` map (fabric folds) drives an SVG `feDisplacementMap` warp,
optionally chained with a low-`curve` `cyl` for torso roundness. Mugs are `cyl` alone (procedural, no map needed —
validated in the POC). A renderer that meets an id it doesn't implement **skips that stage** (graceful degrade:
the design still composites, just less conformed) — so shipping `flat`/`cyl`/`disp` first is forward-compatible.

---

## 4. Cover manifest

The per-product recipe. Authoring JSON uses shorthand keys; the on-chain form is packed (§5).

```json
{ "v":1,
  "p":"<prop atom txid>",          // prop
  "d":"<design preview txid>",     // design (WATERMARKED preview, never the clean product)
  "P":[0.50,0.50,1.00,0],          // place: x, y, scale, rot° — relative to the print region; omit = fill region
  "w":[{"t":"cyl","curve":0.62}]   // OPTIONAL warp override/tweak; omit = inherit the prop's warp
}
```

`p` and `d` may instead be a small **set index** (`u16`) when the prop/design live in the same `.bmc` set as the
cover — avoids repeating a 32-byte txid (see flags, §5).

---

## 5. Packed on-chain encoding (primary form)

Little-endian. The two txid refs dominate; everything else quantizes to ≤2 bytes. Defaults are **omitted** via
flags, so the common cover (design fills the region, prop's own warp) is just header + two refs.

```
off  size  field
0    1     TAG        0x4D ('M')  — mockup cover record
1    1     VERFLAGS   high nibble = version (1); low nibble = flags:
                        bit0 place present      (else: design fills the print region)
                        bit1 warp override present (else: inherit prop default)
                        bit2 prop is set-index (u16)   (else: 32-byte txid)
                        bit3 design is set-index (u16) (else: 32-byte txid)
2    32|2  PROP       txid (32)  or  set index (u16)
..   32|2  DESIGN     txid (32)  or  set index (u16)
                    — the following blocks appear only if their flag is set —
[place]  7  x:u16  y:u16  scale:u16(/1024 → 0..64)  rot:u8(/255 → 0..360°)
[warp]   1+ count:u8, then per stage:  type:u8, plen:u8, plen×param bytes (quantized per §3)
```

**Sizes.** Minimal (two txids, defaults): **66 B**. Mug with a per-cover curve tweak
(`place` off, `warp` = 1 stage × 1 param): **66 + 3 = 69 B**. Fully specified (place + 1 warp stage, 2 params):
**66 + 7 + 4 = 77 B**. Set-indexed refs (prop+design in the same set): **~10 B + params**.

The prop descriptor packs the same way (`print` quad = 8×`u16`; `warp` = the block above; `roles` = a role→member
bitmap + indices), but it rides inside the `.bmc` where the map images set the budget, so packing it is for
consistency, not savings.

### 5.1 Compression — compress-if-smaller, raw for hashes

DEFLATE/gzip shrinks *redundancy*; it does nothing for high-entropy bytes. Apply it only where it actually pays:

- **The cover manifest stays raw.** It is almost entirely two 32-byte txids — SHA-256 hashes, i.e. near-random
  bytes that do not compress. Gzip's ~18-byte header/footer would make a 66-byte record *larger*. Compressing a
  single manifest is a net loss.
- **Content / design payloads → gzip pays.** Text and uncompressed data compress well (SVphone saw ~50%). The
  stack already captures this: `compressIfSmaller` + `RESTRICTION_COMPRESSED` tries DEFLATE and keeps it **only if
  it shrank**, before encrypting. That conditional rule is the correct universal policy — it gzips text and
  *declines* on hashes and already-compressed data automatically.
- **Prop map images are already WebP** (compressed) → gzip adds ≈0.
- **Batches**: a `.bmc` holding many covers that share a prop *does* repeat the 32-byte prop txid — real
  redundancy — but the format already removes it structurally with `u16` **set-index refs**, which beats gzip (no
  header, and it also shrinks the uncompressed form). Gzip the whole bundle only as a last-resort, still
  compress-if-smaller.

**Rule:** *compress-if-smaller everywhere, raw for hashes* — never pay DEFLATE overhead on data that won't shrink.

---

## 6. Rendering pipeline (the compositor)

Deterministic; matches the POC's order (offscreen warp, single composite):

1. Fetch `prop` (`base`,`mask?`,`shade?`,`disp?`) and the `design` preview.
2. Warp the design on an **offscreen canvas** through the pipeline (§3). One canvas, composited once — never draw
   warped slices straight under `multiply` (double-darkens seams → stripes).
3. Project the offscreen onto the base via the **print-region quad** (affine, or triangle-split for perspective).
4. Clip to `mask` (if present).
5. Composite over `base` with **multiply** at the shading strength (from `shade`, or the base region).

Cylinder warp is procedural (canvas column-slice: horizontal `sin()` foreshorten + vertical border-bow).
Displacement warp is an SVG `feDisplacementMap` pass using the prop's `disp` map.

---

## 7. On-chain integration

- **Cover slot.** A mockup cover rides in the existing storefront cover field: `coverMimeType =
  application/vnd.bmf-mockup`, `coverBytes` = the packed record (§5). A client that sees this mime **composites**;
  one that doesn't falls back (below). No new token field.
- **Fallback / cache.** Also cache a **rendered** cover image (render-once, serve-many — the on-chain-data-delivery
  model): crawlers, `<meta og:image>`, and old clients get a flat PNG/WebP; the on-chain truth stays the tiny
  manifest. Big Red's catalog cache is the natural host.
- **Security.** `d` MUST reference the **watermarked public preview**, never the encrypted product atom. The cover
  is marketing; the clean file is delivered on purchase.
- **Immutability.** Minted into TX1, the cover manifest is sealed by the collection txid like every other template
  field — the prop/design/placement a buyer sees can't be swapped after mint.

---

## 8. Examples

**Mug** (procedural, no maps beyond base+shade):
```json
prop:  { "v":1, "print":[[.30,.34],[.66,.34],[.66,.72],[.30,.72]],
         "warp":[{"t":"cyl","curve":0.62,"bow":0.16}], "roles":{"base":"mug.webp","shade":"mug-shade.webp"} }
cover: { "v":1, "p":"<mug-prop tx>", "d":"<design preview tx>" }              // 66 B packed
```

**T-shirt** (fold displacement + torso curve):
```json
prop:  { "v":1, "print":[[.34,.28],[.66,.28],[.66,.60],[.34,.60]],
         "warp":[{"t":"disp","str":14},{"t":"cyl","curve":0.12}],
         "roles":{"base":"tee.webp","shade":"tee-shade.webp","mask":"tee-mask.webp","disp":"tee-disp.webp"} }
cover: { "v":1, "p":"<tee-prop tx>", "d":"<design preview tx>", "P":[0.50,0.46,0.9,0] }   // 73 B packed
```

---

*Status: draft for review. Next: fold `cyl` + `disp` into the compositor in Pole Position `public/`, define the
`.bmc` prop packer/parser alongside the existing BMF codec.*
