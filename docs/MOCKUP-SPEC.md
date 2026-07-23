# Mockup Prop Atoms & Cover Manifests

*Draft v0.2 — a BMF-family format for composing product covers on-chain. See [BMF-SPEC.md](BMF-SPEC.md).*

A product cover (a design shown on a tee, mug, tote, poster…) is not stored as a baked image. It is composited
from reusable parts: a **prop atom** that owns all the geometry, and a **design** that is just a plain image. Same
"reference, don't embed" spine as BMF — one prop photo is minted once and drives thousands of covers, and one
design drops onto every prop of its shape. **Reuse is the whole point: do not store the design×prop combinations.**

| Piece | What | On-chain form |
|---|---|---|
| **Prop atom** | the blank product + its surface maps **+ its own manifest** (geometry, socket ratio, fabric) | a base image FILE + a packed `RECORD_MOCKUP` **prop manifest** (§5), minted once, shared |
| **Design** | the artwork — a plain image, classified by its pixel dimensions into a **socket ratio** (§2) | an atom; the sellable clean file may be encrypted, the public **preview** is what's shown |
| **Product cover** | a tiny **pointer** to the prop (design = the product's own preview), or a one-off full cover | a packed `RECORD_MOCKUP` **cover** record (§5), ~35 B pointer |

The prop carries the geometry; the design carries none. A design composites onto a prop **only when their socket
ratios match** — that match is the entire reuse contract.

---

## 1. Roles across the trifecta

Compositing is **browser-side**; the server never bakes a design onto a prop.

- **Pole Position** (create) — authors a prop `.bmc` (base + maps + descriptor) and designs.
- **Phar Lap** (mint) — mints the prop atom (carrying its manifest) and the product (a pointer to the prop). The
  reusable codec + mint fns live in the shared `src/` core (`mockup.ts`, `mockupIngest.ts`).
- **Big Red** (sell/display) — the **curator** (Node, runs on Big Red's host) resolves chain → caches sample
  images + a `props.json` index; the **browser** (`app.js` + `mockup-render.js`) composites design × prop live.

---

## 2. Socket ratios (the reuse contract)

A design is a plain image. Its **pixel dimensions classify it** into one of five canonical ratios (frozen ids —
the index is the on-chain socket id); a prop declares the ratio it accepts. `ratioOf(w,h)` picks the nearest by
log-aspect (so 3:4 ≈ 4:5). Fewer ratios = one design reuses across more props.

| id | ratio | typical products |
|---|---|---|
| 0 | `1:1`  | tote, sticker, mug (centred), matted poster, phone (centred) |
| 1 | `4:5`  | apparel fronts, posters |
| 2 | `2:3`  | tall art prints, posters |
| 3 | `16:9` | banners, laptop skins, mug wraps |
| 4 | `9:16` | phone cases, story format |

"The main image dimensions determine what props it can be displayed with." The browser offers every prop whose
`ratio` matches the design's — that is the mix-and-match.

---

## 3. Geometry model — two stages

Keeping these separate is what makes one small warp registry cover mugs, shirts and angled flats:

1. **Surface warp** (design-local): shapes the flat design to the *surface* — a mug's curve, a shirt's folds —
   in a plain rectangle. An ordered, extensible **warp pipeline** (§4).
2. **Print placement** (onto the base): a centre/scale/rotation/skew **box** (or a 4-corner **quad** for planar
   perspective) positioning the warped rectangle on the base photo.

Then **mask** (clip to the printable area) and **shading** (multiply the prop's own light over the design at the
prop's `fabric` strength).

```
design → [warp pipeline] → [place box / quad] → [mask] → [× shading] → cover
```

All of this — warp, place, mask/shade refs, fabric, socket ratio — lives in the **prop's** manifest. The design is
a bare rectangle that fills the box (its height derived from its own aspect at render time).

---

## 4. Warp pipeline (extensible)

`warp` is an **ordered array** of stages applied to the design in local space. New surfaces = new stage types;
nothing else changes. Empty array = flat. Stages compose (a tee can be `disp` *then* a gentle `cyl` for the body).

**The full registry is fixed here for future-proofing** — every id and its params are reserved now so any
implementation, present or future, agrees on the numbering. `●` = implemented today · `○` = spec'd, not yet built.

| id | `t` | Surface / use | ● | Params (name → packed byte) |
|---|---|---|:-:|---|
| 0 | `flat` | posters, stickers, flat-lay, labels | ● | — |
| 1 | `cyl` | mugs, cans, bottles, candles, tins | ● | `curve` 0–1→`u8/255` · `bow` −1..1→`i8/127` (sign=smile/frown) · `axis` `u8` 0=vert 1=horiz |
| 2 | `disp` | **t-shirts**, totes, hoodies, fabric, crumpled paper | ● | `str` 0–64px→`u8·0.25` · `map` `u8` role-id (default `disp`) |
| 3 | `persp` | angled planar skew beyond the print quad | ● | `kx` `ky` −1..1→`i8/127` |
| 4 | `bulge` | pillows, balloons, badges, buttons, cushions | ○ | `amt` −1..1→`i8/127` (barrel/pincushion) |
| 5 | `sphere` | balls, globes, ornaments, domes, lenses | ○ | `curve` 0–1→`u8/255` |
| 6 | `cone` | tapered tumblers, lampshades, cups, buckets | ○ | `taper` 0–1→`u8/255` · `curve` `u8/255` |
| 7 | `mesh` | arbitrary freeform surfaces (scanned props) | ○ | `cols` `u8` · `rows` `u8` · then offsets, or `map` role-id (variable → `raw`) |
| 8 | `ripple` | water, reflective surfaces, concentric | ○ | `amp` · `freq` · `phase` · `axis` (all `u8`) |
| 9 | `wave` | hanging fabric, flags, banners, curtains | ○ | `amp` `u8` · `len` `u8` · `angle` `u8` (0–360) |
| 10 | `curl` | page/sticker curl, peeling corner | ○ | `amt` `u8` · `corner` `u8` (0–3 TL/TR/BR/BL) |
| 11 | `emboss` | engraving, letterpress, deboss, relief | ○ | `depth` −1..1→`i8/127` |
| 12 | `fold` | folded posters, maps, greeting cards | ○ | variable → `raw` |
| 13 | `skew` | quick affine shear | ● | `sx` `sy` −1..1→`i8/127` |
| 14 | — | *reserved* | — | — |
| 15 | `ext` | escape hatch for anything beyond the table | — | `raw` param bytes |

Each stage packs as `[type:u8, plen:u8, plen×param bytes]`. A renderer that meets an id it doesn't implement
**skips that stage** by its `plen` (graceful degrade); variable/unknown types round-trip via raw bytes.

---

## 5. Packed on-chain encoding

Two record types share the `RECORD_MOCKUP` PushDrop output, distinguished by their leading TAG byte:

- **`0x50` 'P' — PROP manifest** (rides the PROP mint): the self-describing geometry (§5.1).
- **`0x4D` 'M' — COVER** (rides the PRODUCT mint): a pointer to a prop, or a one-off full cover (§5.2).

### 5.1 Prop manifest — TLV blocks (extensible)

A stream of tagged blocks so new parameters never break old parsers (a t-shirt contour map, fold lines, light
direction… all slot in as new ids). A parser reads the ids it knows and **skips any unknown id by its length**,
preserving it verbatim for a lossless round-trip.

```
off  size  field
0    1     TAG        0x50 ('P')
1    1     version    bump only for INCOMPATIBLE changes; new fields are additive (no bump)
2..  —     blocks, each:  id:u8  len:u8 (0xFF → u16 follows)  value[len]
```

**Field-id registry** (frozen, additive; `0x0B–0xFE` reserved for future params):

| id | field | value |
|---|---|---|
| 0x01 | `RATIO` | `u8` socket id (§2) |
| 0x02 | `FABRIC` | `u8` ×255 — shading strength 0..1 |
| 0x03 | `PLACE` | 9 B print box: `x:u16` `y:u16` (÷65535) · `scale:u16` (÷1024) · `rot:u8` (÷255→360°) · `skewX:i8` `skewY:i8` (÷127) |
| 0x04 | `WARP` | the warp pipeline (§4): `count:u8` then stages |
| 0x05 | `QUAD` | 16 B — 4 corners `x:u16 y:u16` (÷65535); planar-perspective alt/added to PLACE |
| 0x06 | `DISP` | 33 B — displacement/contour map atom `txid(32)` + `str:u8` (÷255). The t-shirt fabric contour. |
| 0x07 | `MASK` | 32 B — print-area cutout atom `txid` |
| 0x08 | `SHADE` | 32 B — baked shade/AO atom `txid` |
| 0x09 | `DIMS` | 4 B — physical print size `wmm:u16 hmm:u16` |
| 0x0A | `NAME` | UTF-8 label |

Height is **not** stored — the design's own aspect gives the box height at render (only PLACE `scale` = width).
Minimal prop (RATIO + FABRIC) ≈ 8 B; a real tee (ratio, fabric, place, 2-stage warp, name) ≈ 40 B.

### 5.2 Cover record (`0x4D`)

The product's cover. **Pointer form** (the norm): prop ref + design *embedded* (the design IS the product's own
storefront preview) + no geometry → **~35 B**; geometry is inherited from the prop's manifest. **Full one-off
form**: carries its own design ref + place + warp, self-contained, for a bespoke single that doesn't reuse a prop.

```
0    1     TAG        0x4D ('M')
1    1     VERSION
2    1     FLAGS      bit0 place · bit1 warp · bit2 prop set-index · bit3 design set-index · bit4 design embedded
3    32|2  PROP       txid (32) or set-index (u16)
..   32|2  DESIGN     present only if NOT embedded — txid (32) or set-index (u16)
[place] 10 x:u16 y:u16 scale:u16 rot:u8 skewX:i8 skewY:i8 fabric:u8   (one-off only)
[warp]  1+ the warp block (one-off only)
```

Pointer (embedded design, prop txid, no place/warp) = TAG+VER+FLAGS+32 = **35 B**.

### 5.3 Compression — compress-if-smaller, raw for hashes

DEFLATE/gzip shrinks *redundancy*; it does nothing for high-entropy bytes. Apply it only where it pays:

- **The manifest/cover records stay raw** — dominated by 32-byte txids (SHA-256, near-random). Gzip's ~18-byte
  header would make a 35–40 B record *larger*.
- **Content/design payloads → gzip pays** — captured by `compressIfSmaller` + `RESTRICTION_COMPRESSED` (tries
  DEFLATE, keeps it **only if it shrank**, before encrypting). The curator inflates a gzip'd prop base before use.
- **Prop map images are already WebP** → gzip adds ≈0.

**Rule:** *compress-if-smaller everywhere, raw for hashes.*

---

## 6. Rendering & delivery

**Server does NOT composite.** (An earlier `@napi-rs/canvas` server render was removed — the 33 MB skia native
module OOM-killed the memory-capped shared-host cron and couldn't decode the images.) Two roles instead:

**Curator (Node, on Big Red's host)** — per mockup listing, using **ImageMagick → GraphicsMagick → PHP-Imagick →
PHP-GD** (whichever the host has; all run as cheap separate processes), from the design preview into a transient
temp file (never served), emit two WebP:
- **watermarked** low-res (`covers/<id>.webp`, domain overlay) → crawlers, bots, `og:image`;
- **clean** low-res (`covers/<id>-clean.webp`) → the browser's compositing source.

It also caches each prop's base image → `props/<txid>.webp`, and writes **`props.json`** (every self-describing
prop: base + ratio + geometry) so the browser can offer all props of a design's ratio. Each mockup listing carries
`mockup:{ clean, prop, base, ratio, place, warp, fabric }`.

**Browser (Big Red `app.js` + `mockup-render.js`)** — composites, deterministically (offscreen warp, single
composite — never draw warped slices straight under `multiply`; that double-darkens seams into stripes):
1. Load the clean design + prop base.
2. Warp the design offscreen through the pipeline (§4). `cyl` is procedural (column-slice: `sin()` foreshorten +
   border-bow); `disp` uses the prop's `disp` map; `persp` is a keystone taper (cap edge scale ≤1); supersample ×2
   to anti-alias the slice staircase.
3. Place onto the base via the box (or quad), clip to `mask` if present.
4. Composite over the base with **multiply** at `fabric` (or a `shade` map).
5. A **prop switcher** (props of the matching ratio, from `props.json`) re-composites live = mix-and-match.

Failure at any step degrades to the flat watermarked cover.

---

## 7. On-chain integration

- **Records.** Prop mint emits a `RECORD_MOCKUP` output = `packProp(manifest)` (`0x50`). Product mint emits a
  `RECORD_MOCKUP` output = the cover pointer `packCover({prop, design:embedded})` (`0x4D`) alongside its normal
  storefront cover (the public design preview) + encrypted clean FILE.
- **Security.** A public cover/preview MUST be the **watermarked/degraded** image, never the encrypted clean
  product. On a public chain plaintext-on-chain is free to read — so the protection is: encrypted clean file +
  low-res watermarked preview + the compositor's own distortion. Ownership/licence/resale/provenance are the
  product, not the pixels.
- **Immutability.** Both records are minted into TX1, sealed by the collection txid — prop geometry and the
  product's prop pointer can't be swapped after mint. (A one-off full cover is likewise immutable.)
- **Reuse.** A prop is minted once; every product that references it is a ~35 B pointer. Mint a new prop → the whole
  catalogue of matching-ratio designs can render onto it, no re-mint of any design.

---

## 8. Examples

**Prop — white mug** (`1:1`, procedural cyl, base+shade):
```jsonc
// packProp →
{ "ratio": 0, "fabric": 0.8,
  "place": { "x":0.48,"y":0.5,"scale":0.36,"rot":0,"skewX":0,"skewY":0 },
  "warp":  [ { "t":"cyl","curve":0.62,"bow":0.16 } ],
  "shade": "<mug-shade atom tx>", "name": "white-mug-11oz" }         // ~45 B packed
```

**Prop — t-shirt** (`4:5`, fold displacement + torso curve, contour map):
```jsonc
// packProp →
{ "ratio": 1, "fabric": 0.83,
  "place": { "x":0.5,"y":0.62,"scale":0.4,"rot":0,"skewX":0,"skewY":0 },
  "warp":  [ { "t":"persp","kx":0.1,"ky":-0.05 }, { "t":"cyl","curve":0.12,"bow":0.1 } ],
  "disp":  { "tx":"<tee-contour atom tx>", "str":0.5 },
  "mask":  "<tee-mask atom tx>", "name": "unisex-tee-front" }
```

**Product cover — a design on that tee** (pointer; design = the product's own preview):
```jsonc
// packCover →  { prop:"<tee-prop tx>", design: <embedded> }          // 35 B packed
```

---

*Status: draft v0.2 — matches the shipped codec (`PharLap/src/mockup.ts`: `packProp`/`parseProp`, `packCover`,
`RATIOS`/`ratioOf`), curator samples (`imageSamples.ts`), and browser compositor (`BigRed/app.js` +
`mockup-render.js`). Next: the prop switcher UI (props of the matching ratio) and more props to exercise it.*
