// Product-mockup authoring (Pole Position). Compose a design onto a reusable prop, preview live via the shared
// renderer (mockup-render.js), and export a bundle (prop images + a recipe) for PharLap to mint. Classic script,
// loaded AFTER app.js + mockup-render.js — reuses app.js globals (makeZip, triggerDownload) and
// window.MockupRender. See docs/MOCKUP-SPEC.md.
(function () {
  'use strict'
  var R = window.MockupRender
  function $(id) { return document.getElementById(id) }
  var modal = $('mockupModal'), canvas = $('mkCanvas')
  if (!modal || !canvas || !R) return

  var ctx = canvas.getContext('2d')
  var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
  var st = {
    base: null, design: null, baseFile: null, designFile: null,
    maps: {}, mapFiles: {},
    x: 0, y: 0, scale: 1, rot: 0, fabric: 0.8, curve: 0, skewX: 0, skewY: 0, perspV: 0, perspH: 0,
    stageW: 0, stageH: 0,
  }

  function loadImage(file) {
    return new Promise(function (res, rej) {
      var im = new Image()
      im.onload = function () { res(im) }
      im.onerror = function () { rej(new Error('could not load image')) }
      im.src = URL.createObjectURL(file)
    })
  }

  function designSize() {
    if (!st.design) return { w: 0, h: 0 }
    var base = st.stageW * 0.45 * st.scale
    var ar = st.design.naturalWidth / st.design.naturalHeight
    return ar >= 1 ? { w: base, h: base / ar } : { w: base * ar, h: base }
  }

  function fitStage() {
    if (!st.base) return
    var host = ($('mkStage').clientWidth || 440) - 2
    var w = Math.min(host, 620)
    var h = w * st.base.naturalHeight / st.base.naturalWidth
    st.stageW = w; st.stageH = h
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px'
  }

  function warpStages() {
    return [
      { t: 'persp', kx: st.perspH, ky: st.perspV },
      { t: 'cyl', curve: st.curve, bow: 0.8 * st.curve, axis: 0 },
    ]
  }

  function render(forExport) {
    if (!st.base) return
    var s = designSize()
    R.renderCover(ctx, {
      base: st.base, design: st.design, maps: st.maps,
      stageW: st.stageW, stageH: st.stageH, dpr: dpr,
      box: st.design ? { cx: st.x, cy: st.y, w: s.w, h: s.h, rot: st.rot, skewX: st.skewX, skewY: st.skewY } : null,
      warp: st.design ? warpStages() : [], fabric: st.fabric,
    })
    if (!forExport && st.design) {
      ctx.save()
      ctx.translate(st.x, st.y); ctx.rotate(st.rot * Math.PI / 180)
      if (st.skewX || st.skewY) ctx.transform(1, st.skewY, st.skewX, 1, 0, 0)
      ctx.strokeStyle = 'rgba(255,117,24,.9)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4])
      ctx.strokeRect(-s.w / 2, -s.h / 2, s.w, s.h)
      ctx.restore(); ctx.setLineDash([])
    }
  }

  function showStage() {
    $('mkEmpty').hidden = !!st.base
    canvas.hidden = !st.base
    $('mkExport').disabled = !(st.base && st.design)
  }

  // [id, label, min, max, default, format(v), apply(v)]
  var SLIDERS = [
    ['scale', 'Scale', 15, 220, 100, function (v) { return v + '%' }, function (v) { st.scale = v / 100 }],
    ['rot', 'Rotation', -45, 45, 0, function (v) { return v + '°' }, function (v) { st.rot = v }],
    ['fabric', 'Shading', 0, 100, 80, function (v) { return v + '%' }, function (v) { st.fabric = v / 100 }],
    ['curve', 'Wrap curve', 0, 100, 0, function (v) { return v + '%' }, function (v) { st.curve = v / 100 }],
    ['skewH', 'Skew ↔', -60, 60, 0, String, function (v) { st.skewX = v / 100 }],
    ['skewV', 'Skew ↕', -60, 60, 0, String, function (v) { st.skewY = v / 100 }],
    ['perspH', 'Perspective ↔', -80, 80, 0, String, function (v) { st.perspH = v / 100 }],
    ['perspV', 'Perspective ↕', -80, 80, 0, String, function (v) { st.perspV = v / 100 }],
  ]
  var built = false
  function buildSliders() {
    if (built) return
    var host = $('mkControls'); host.innerHTML = ''
    SLIDERS.forEach(function (s) {
      var id = s[0], label = s[1], min = s[2], max = s[3], def = s[4], fmt = s[5]
      var wrap = document.createElement('div')
      wrap.innerHTML =
        '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">' +
        '<label for="mk_' + id + '">' + label + '</label>' +
        '<span id="mk_' + id + 'v" style="color:#ff7518;font-variant-numeric:tabular-nums">' + fmt(def) + '</span></div>' +
        '<input type="range" id="mk_' + id + '" min="' + min + '" max="' + max + '" value="' + def + '" style="width:100%;accent-color:#ff7518">'
      host.appendChild(wrap)
      var input = $('mk_' + id), out = $('mk_' + id + 'v')
      input.addEventListener('input', function () { var v = parseFloat(input.value); s[6](v); out.textContent = fmt(v); render() })
    })
    built = true
  }
  function resetControls() {
    SLIDERS.forEach(function (s) {
      var input = $('mk_' + s[0]), out = $('mk_' + s[0] + 'v')
      if (input) { input.value = s[4]; s[6](s[4]); out.textContent = s[5](s[4]) }
    })
    st.x = st.stageW / 2; st.y = st.stageH / 2
    render()
  }

  function onFile(kind, file) {
    if (!file) return
    loadImage(file).then(function (img) {
      if (kind === 'base') { st.base = img; st.baseFile = file; $('mkPropName').textContent = file.name; fitStage(); st.x = st.stageW / 2; st.y = st.stageH / 2 }
      else if (kind === 'design') { st.design = img; st.designFile = file; $('mkDesignName').textContent = file.name; if (st.base) { st.x = st.stageW / 2; st.y = st.stageH / 2 } }
      else { st.maps[kind] = img; st.mapFiles[kind] = file; $('mkMapsInfo').textContent = 'loaded: ' + Object.keys(st.maps).join(', ') }
      showStage(); render()
    }).catch(function (e) { $('mkStatus').textContent = e.message })
  }

  // drag to reposition
  var dragging = false, gx = 0, gy = 0
  canvas.addEventListener('pointerdown', function (e) {
    if (!st.design) return
    var s = designSize(), dx = e.offsetX - st.x, dy = e.offsetY - st.y
    if (Math.abs(dx) <= s.w / 2 + 14 && Math.abs(dy) <= s.h / 2 + 14) {
      dragging = true; gx = dx; gy = dy; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'
    }
  })
  canvas.addEventListener('pointermove', function (e) {
    if (!dragging) return
    st.x = Math.max(0, Math.min(st.stageW, e.offsetX - gx))
    st.y = Math.max(0, Math.min(st.stageH, e.offsetY - gy))
    render()
  })
  function endDrag() { dragging = false; canvas.style.cursor = 'grab' }
  canvas.addEventListener('pointerup', endDrag)
  canvas.addEventListener('pointercancel', endDrag)

  // Props/maps display at a few hundred px on a cover, so a 2048² source is ~4× waste. Downscale them on export
  // (resample — keeps the whole subject, unlike a crop) then WebP-encode → a big on-chain saving, imperceptible at
  // cover size. NOTE: the DESIGN is exempt — it's the sellable product a buyer PRINTS, so it's preserved full-res
  // + original format (see exportBundle). Only base + maps go through this.
  var PROP_MAX = 1024   // base + maps
  function toWebpScaled(file, maxDim, quality) {
    quality = quality == null ? 0.9 : quality
    return createImageBitmap(file).then(function (bmp) {
      var scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height)) // only ever shrink, never upscale
      var tw = Math.max(1, Math.round(bmp.width * scale)), th = Math.max(1, Math.round(bmp.height * scale))
      var cv = document.createElement('canvas'); cv.width = tw; cv.height = th
      var c = cv.getContext('2d'); c.imageSmoothingQuality = 'high'
      c.drawImage(bmp, 0, 0, tw, th)
      if (bmp.close) bmp.close()
      return new Promise(function (res, rej) {
        cv.toBlob(function (b) {
          if (!b) { rej(new Error('WebP encode failed')); return }
          b.arrayBuffer().then(function (ab) { res(new Uint8Array(ab)) })
        }, 'image/webp', quality)
      })
    })
  }

  // Read a file's bytes VERBATIM (no re-encode) — used for the design, kept at full PoD resolution + original
  // format (a PNG stays lossless with alpha). Extension/mime come from the uploaded file.
  function rawBytes(file) { return file.arrayBuffer().then(function (ab) { return new Uint8Array(ab) }) }
  function designExt(file) {
    var m = /\.([a-z0-9]+)$/i.exec(file.name || '')
    if (m) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()
    var t = (file.type || '').split('/')[1] || 'png'
    return t === 'jpeg' ? 'jpg' : t
  }

  // Export the prop images (downscaled) + the FULL-RES design + a readable recipe, in one store-only .bmc bundle.
  function exportBundle() {
    if (!(st.base && st.design)) return
    var name = ($('mkName').value.trim() || 'mockup').replace(/[^a-z0-9._-]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '') || 'mockup'
    $('mkStatus').textContent = 'Packing…'
    var dExt = designExt(st.designFile)
    var dName = 'design.' + dExt
    var dMime = st.designFile.type || ('image/' + (dExt === 'jpg' ? 'jpeg' : dExt))
    var entries = [], roles = { base: 'base.webp' }
    var jobs = [
      toWebpScaled(st.baseFile, PROP_MAX).then(function (b) { entries.push({ name: 'base.webp', bytes: b }) }),
      rawBytes(st.designFile).then(function (b) { entries.push({ name: dName, bytes: b }) }), // sellable master — full res, original format
    ]
    ;['mask', 'shade', 'disp'].forEach(function (k) {
      if (st.mapFiles[k]) jobs.push(toWebpScaled(st.mapFiles[k], PROP_MAX).then(function (b) { entries.push({ name: k + '.webp', bytes: b }); roles[k] = k + '.webp' }))
    })
    Promise.all(jobs).then(function () {
      var s = designSize()
      var recipe = {
        v: 1,
        prop: { name: name, roles: roles, warp: [{ t: 'persp', kx: st.perspH, ky: st.perspV }, { t: 'cyl', curve: st.curve, bow: 0.8 * st.curve, axis: 0 }] },
        design: dName,
        designMime: dMime,
        place: { cx: st.x / st.stageW, cy: st.y / st.stageH, w: s.w / st.stageW, h: s.h / st.stageH, rot: st.rot, skewX: st.skewX, skewY: st.skewY },
        fabric: st.fabric,
      }
      entries.push({ name: 'mockup.json', bytes: new TextEncoder().encode(JSON.stringify(recipe, null, 2)) })
      var blob = makeZip(entries)
      var dKB = Math.round((entries.find(function (e) { return e.name === dName }) || { bytes: [] }).bytes.length / 1024)
      triggerDownload(blob, name + '-mockup.bmc')
      $('mkStatus').textContent = 'Exported ' + name + '-mockup.bmc (' + Math.round(blob.size / 1024) + ' KB · design ' + dExt.toUpperCase() + ' ' + dKB + ' KB full-res) — mint it in PharLap.'
    }).catch(function (e) { $('mkStatus').textContent = 'Export failed: ' + e.message })
  }

  // wiring
  $('mkOpen').addEventListener('click', function () { buildSliders(); modal.hidden = false })
  $('mkClose').addEventListener('click', function () { modal.hidden = true })
  modal.addEventListener('click', function (e) { if (e.target === modal) modal.hidden = true })
  $('mkProp').addEventListener('change', function (e) { onFile('base', e.target.files[0]) })
  $('mkDesign').addEventListener('change', function (e) { onFile('design', e.target.files[0]) })
  $('mkMask').addEventListener('change', function (e) { onFile('mask', e.target.files[0]) })
  $('mkShade').addEventListener('change', function (e) { onFile('shade', e.target.files[0]) })
  $('mkDisp').addEventListener('change', function (e) { onFile('disp', e.target.files[0]) })
  $('mkExport').addEventListener('click', exportBundle)
  $('mkReset').addEventListener('click', resetControls)
})()
