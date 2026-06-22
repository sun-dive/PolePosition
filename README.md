# 🏁 Pole Position

A local-first, AI-assisted ebook studio: write and illustrate a book with an AI co-author, then publish it on-chain as a SMART NFT.

## Run

```
npm install
node server.mjs
```

Open **http://localhost:4321**. Drafts autosave in your browser; **Export draft** saves a `.json` backup.

## AI writing

Runs on your own Claude via the **Claude Agent SDK** — **no API key is needed or stored**, and the browser only ever talks to `localhost`. Optionally set `CLAUDE_MODEL` in a local `.env`. (Image generation, coming next, uses fal.ai with its own `FAL_API_KEY`.)

## Status

Early and evolving — the chapter editor and AI writing assist work today; cover/illustration art, EPUB export, and on-chain publishing are in progress.
