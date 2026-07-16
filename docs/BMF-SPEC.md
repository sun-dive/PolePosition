# Block Media Format (BMF)

Pole Position authors the **Block Media Format**: its Music-video timeline exports a **`.bmc`**
(media files + a **`.bmf`** cue manifest) — the format smart-NFT players read to sequence
composable, on-chain audio/video from reusable media loops.

The canonical, MIT-licensed spec, examples, and the `.bmf`/`.bmc` definitions live in their own repo:

**→ https://github.com/sun-dive/block-media-format**

Short version:
- **`.bmf`** = the timing manifest (LRC-style cue or JSON). With on-chain **txid** references it is
  a fully on-chain composable video.
- **`.bmc`** = a ZIP of a `.bmf` + its media (portable). Pole Position's current
  `music-video-bundle.zip` (media + `video.cue`) is the de-facto `.bmc`.
