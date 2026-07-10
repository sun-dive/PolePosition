// Pole Position — Electron desktop shell.
//
// This does NOT rewrite the app: it boots the existing local server (../server.mjs) inside Electron's main
// process, waits until it's listening, then loads it in a native window. Day-to-day development is unchanged —
// you can still run `node server.mjs` + a browser; this just gives the same app a real window (and, later, an
// installer). Native tools (ffmpeg / magick / flac) and the Claude Agent SDK run exactly as they do today.
import { app, BrowserWindow, dialog, shell } from 'electron'
import { spawnSync } from 'node:child_process'
import { join, delimiter } from 'node:path'
import { existsSync } from 'node:fs'
import net from 'node:net'

// GUI-launched (double-clicked) apps don't inherit your shell's PATH, so `claude`, ffmpeg, magick and flac can be
// invisible even though they work in a terminal. Prepend the usual bin dirs so child-process spawns find them.
function fixPath () {
  const home = app.getPath('home')
  const extra = ['/usr/local/bin', '/usr/bin', '/bin', '/opt/homebrew/bin', '/opt/local/bin',
    join(home, '.local', 'bin'), join(home, 'bin')]
  const seen = new Set(); const parts = []
  for (const p of [...extra, ...(process.env.PATH || '').split(delimiter)]) {
    if (p && !seen.has(p)) { seen.add(p); parts.push(p) }
  }
  process.env.PATH = parts.join(delimiter)
}

// A free ephemeral port, so the app never clashes with a dev `node server.mjs` (or anything) on 4321.
function getFreePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)) })
  })
}

// Poll until the server is accepting connections (server.mjs listens async on import).
function waitForPort (port, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1')
      sock.once('connect', () => { sock.destroy(); resolve() })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() - start > timeoutMs) reject(new Error(`server did not respond on port ${port}`))
        else setTimeout(attempt, 200)
      })
    }
    attempt()
  })
}

// Non-blocking heads-up: AI features need the Claude subscription; everything else works without it.
// Detect the SUBSCRIPTION CREDENTIALS (~/.claude/.credentials.json), NOT a `claude` command on PATH: the Agent
// SDK reads those creds and ships its own binary in node_modules, so a GUI app that has no PATH `claude` (the
// normal case) still writes fine. Fall back to a PATH `claude` for setups that store creds elsewhere; warn only
// if neither is present.
function warnIfNoClaude () {
  const home = app.getPath('home')
  const signedIn = existsSync(join(home, '.claude', '.credentials.json')) ||
    existsSync(join(home, '.claude', '.credentials')) ||
    !spawnSync('claude', ['--version'], { stdio: 'ignore' }).error
  if (!signedIn) {
    void dialog.showMessageBox({
      type: 'info',
      title: 'Claude Code not detected',
      message: "Pole Position's AI writing and art use your Claude Code subscription.",
      detail: 'Install Claude Code and run "claude login", then reopen Pole Position. The editor and the media tools (sequence, music-video, lyrics, WAV→FLAC) all work without it.',
      buttons: ['Get Claude Code', 'Continue'],
      defaultId: 1,
    }).then(({ response }) => { if (response === 0) void shell.openExternal('https://claude.com/product/claude-code') })
  }
}

let win
function createWindow (port) {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Pole Position',
    backgroundColor: '#1b1b1f',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  void win.loadURL(`http://127.0.0.1:${port}`)
  win.webContents.setWindowOpenHandler(({ url }) => {
    // The PDF export opens a blank window and writes the print view into it — let Electron create that window.
    // (Denying it and shell-opening the URL is what caused "Could not read file about:blank".)
    if (url === 'about:blank' || url === '') return { action: 'allow' }
    // Real external links (fal docs, etc.) open in the system browser, not a stray Electron window.
    void shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(async () => {
  fixPath()
  let port
  try {
    port = process.env.PORT || String(await getFreePort())
    process.env.PORT = port // server.mjs reads process.env.PORT || 4321
    await import(new URL('../server.mjs', import.meta.url).href) // boot the local server (listens on PORT)
    await waitForPort(Number(port))
  } catch (e) {
    dialog.showErrorBox('Pole Position failed to start', String(e?.message ?? e))
    app.quit(); return
  }
  createWindow(port)
  warnIfNoClaude()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(port) })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
