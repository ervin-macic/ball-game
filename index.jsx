import React, { useEffect, useRef, useState } from 'react'
import { createParty, PartyOverlay } from './party.jsx'

// Ball Game's Godot web build runs directly in this app frame: the frame's
// policy allows WebAssembly, while the packaged-document lane (/app-embeds
// documents) does not. Engine files are fetched from the app's static assets.
// tools/build_web.py produces them; see README.md.

const CSS = `
  .bg-root {
    position: fixed;
    inset: 0;
    overflow: hidden;
    background: #16202e;
    color: var(--text);
    font-family: var(--font);
  }
  .bg-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    outline: none;
    opacity: 0;
    transition: opacity 240ms ease;
  }
  .bg-canvas.is-live { opacity: 1; }
  .bg-cover {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: max(24px, var(--mobius-safe-top, 0px)) 24px max(24px, var(--mobius-safe-bottom, 0px));
    background: radial-gradient(circle at 50% 30%, var(--surface), var(--bg) 70%);
  }
  .bg-card {
    width: min(360px, 100%);
    display: grid;
    justify-items: center;
    gap: 14px;
    text-align: center;
  }
  .bg-stage {
    position: relative;
    width: 168px;
    height: 72px;
  }
  .bg-track {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 10px;
    height: 4px;
    border-radius: 2px;
    background: var(--accent);
    opacity: 0.85;
  }
  .bg-ball {
    position: absolute;
    left: 56px;
    bottom: 14px;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    border: 3px solid #0b1018;
    background: conic-gradient(#ff7a1a 0 25%, #fff4e6 0 50%, #ff7a1a 0 75%, #fff4e6 0);
    animation: bg-roll 1.1s linear infinite;
  }
  @keyframes bg-roll { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .bg-ball { animation: none; } }
  .bg-title { margin: 0; font-size: 1.5rem; font-weight: 750; letter-spacing: -0.02em; }
  .bg-status { margin: 0; color: var(--muted); font-size: 0.95rem; min-height: 1.4em; }
  .bg-bar {
    width: 100%;
    height: 8px;
    border-radius: 999px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    overflow: hidden;
  }
  .bg-bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 160ms linear;
  }
  .bg-error { margin: 0; color: var(--text); font-size: 0.95rem; line-height: 1.5; }
  .bg-detail {
    margin: 0;
    max-width: 100%;
    color: var(--muted);
    font-size: 0.8rem;
    overflow-wrap: anywhere;
  }
  .bg-button {
    min-height: 44px;
    padding: 0 20px;
    border-radius: 12px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--bg);
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }
  .bg-button:focus-visible { outline: 3px solid var(--text); outline-offset: 2px; }
  .bg-hint {
    position: absolute;
    left: 50%;
    top: 58%;
    transform: translateX(-50%);
    padding: 10px 18px;
    border-radius: 999px;
    background: rgba(8, 12, 20, 0.72);
    color: #fff;
    font-weight: 700;
    pointer-events: none;
    white-space: nowrap;
  }
  .bg-note {
    position: absolute;
    left: 50%;
    bottom: max(16px, var(--mobius-safe-bottom, 0px));
    transform: translateX(-50%);
    max-width: calc(100% - 32px);
    padding: 8px 14px;
    border-radius: 12px;
    background: rgba(8, 12, 20, 0.72);
    color: #fff;
    font-size: 0.85rem;
    text-align: center;
    pointer-events: none;
  }
`

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Engine) return resolve()
    const script = document.createElement('script')
    // CORS (the assets answer with ACAO *) keeps errors raised inside the engine
    // script readable instead of the browser's sanitised "Script error.".
    script.crossOrigin = 'anonymous'
    script.src = src
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('The game engine script could not be loaded.'))
    document.head.appendChild(script)
  })
}

// The engine asks for index.wasm; the app ships index.wasm.gz (static assets are
// capped at 16 MiB) and unpacks it while it streams, so download progress stays live.
function serveCompressedFiles(base, compressed) {
  if (window.__ballGameFetch) return
  const nativeFetch = window.fetch.bind(window)
  window.__ballGameFetch = true
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    const packed = url.startsWith(base) && compressed[url.slice(base.length)]
    if (!packed) return nativeFetch(input, init)
    return nativeFetch(base + packed, init).then((response) => {
      if (!response.ok || !response.body) return response
      const unpacked = response.body.pipeThrough(new DecompressionStream('gzip'))
      return new Response(unpacked, { status: 200, headers: { 'Content-Type': 'application/wasm' } })
    })
  }
}

// The game keeps small JSON documents (settings, best times, every run, the
// best run's ghost) through ball-game/scripts/core/game_store.gd. This frame has
// no IndexedDB, so the engine's own user:// files would vanish on reload; the
// documents live in app storage instead. They are read up front because
// JavaScriptBridge calls from the engine are synchronous.
const DOCUMENT_NAME = /^[A-Za-z0-9_.-]+\.json$/

async function exposeStore(storage) {
  const documents = new Map()
  try {
    const { entries } = await storage.listWithStatus('', { includeContent: true })
    await Promise.all(entries.map(async (entry) => {
      const name = entry.name || entry.path
      if (!DOCUMENT_NAME.test(name || '')) return
      const value = 'content' in entry ? entry.content : await storage.get(name)
      if (value != null) documents.set(name, JSON.stringify(value))
    }))
  } catch (err) {
    window.mobius?.signal('error', { message: String(err?.message || err), source: 'store_load' })
  }
  const report = (source) => (err) => {
    window.mobius?.signal('error', { message: String(err?.message || err), source })
  }
  window.ballGameStore = {
    read_doc(name) {
      return documents.get(name) ?? null
    },
    write_doc(name, text) {
      if (!DOCUMENT_NAME.test(name)) return
      documents.set(name, text)
      storage?.set(name, JSON.parse(text)).catch(report('store_write'))
      if (name.startsWith('runs_')) window.mobius?.signal('item_created', { type: 'run' })
    },
    remove_doc(name) {
      documents.delete(name)
      storage?.remove(name).catch(report('store_remove'))
    },
  }
}

// The community leaderboard (ball-game/scripts/race/community_board.gd). The
// game calls submit/refresh without waiting and polls state(); the requests go
// to this app's own service (service.py), which talks to the shared board.
// Tokens are short-lived, so calls read the latest one the component was given.
const communityAuth = { appId: null, token: null }

function exposeCommunity() {
  const tracks = new Map()
  let version = 0
  const entry = (track) => {
    if (!tracks.has(track)) tracks.set(track, { status: 'idle', message: '', board: null, submission: null })
    return tracks.get(track)
  }
  const update = (track, change) => {
    Object.assign(entry(track), change)
    version += 1
  }
  const call = async (path, body) => {
    let response
    try {
      response = await fetch(`/api/apps/${communityAuth.appId}/service/${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${communityAuth.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch {
      throw new Error('You seem to be offline.')
    }
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      const detail = typeof data?.detail === 'string' ? data.detail : null
      throw new Error(data?.error || detail || `The leaderboard answered ${response.status}.`)
    }
    return data
  }
  const refresh = async (track) => {
    update(track, { status: 'loading' })
    try {
      const board = await call(`board?track=${encodeURIComponent(track)}`)
      update(track, { status: 'ready', message: '', board })
    } catch (err) {
      update(track, { status: 'error', message: String(err?.message || err) })
    }
  }
  window.ballGameCommunity = {
    refresh(track) {
      refresh(String(track))
    },
    submit(track, time, ghostText, requestId) {
      const name = String(track)
      const id = String(requestId)
      update(name, { submission: { id, status: 'sending' } })
      call('submit', { track: name, time: Number(time), ghost: JSON.parse(ghostText), request_id: id })
        .then((result) => {
          update(name, { submission: { id, status: 'done', result } })
          refresh(name)
        })
        .catch((err) => {
          update(name, { submission: { id, status: 'error', message: String(err?.message || err) } })
        })
    },
    state(track) {
      return JSON.stringify({ version, ...entry(String(track)) })
    },
  }
}

// Party mode (party.jsx): one party controller per page, over this app's live
// rooms. The game reaches it as window.ballGameParty.
let party = null
function exposeParty() {
  if (party || !window.mobius?.live) return
  party = createParty({ live: window.mobius.live })
  window.ballGameParty = party.bridge
}

// Whether anyone can see the game: Möbius keeps recently used apps running
// out of sight (closing an app's tab only hides it) and tells the frame with a
// moebius:frame-visibility message; the browser can also hide the whole page.
// The game (ball-game/scripts/core/app_suspend.gd) polls hidden() and sleeps:
// paused, silent and barely drawn.
const visibility = { frameVisible: true }
function exposeHost() {
  if (window.ballGameHost) return
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return
    const data = event.data
    if (data && data.type === 'moebius:frame-visibility') visibility.frameVisible = data.visible !== false
  })
  window.ballGameHost = {
    hidden() {
      return !visibility.frameVisible || document.visibilityState === 'hidden'
    },
    // How smoothly a run played (perf_report.gd): frame rate, long frames and
    // where they were, drawing time; plus how long the engine worked on each
    // frame (engine_ms, engine_long), timed here.
    run_started() {
      engineFrames.busy.length = 0
    },
    run_perf(json) {
      let report = null
      try {
        report = JSON.parse(String(json))
      } catch {
        return
      }
      window.mobius?.signal('run_perf', { ...report, ...engineFrameStats(), browser: browserLabel() })
    },
    // A level is ready to play (level_loader.gd): how long each part of
    // loading took, with the graphics programs compiled so far, so slow loads
    // on a player's own machine can be looked into.
    level_ready(json) {
      let report = null
      try {
        report = JSON.parse(String(json))
      } catch {
        return
      }
      window.mobius?.signal('level_ready', {
        ...report,
        programs: shaderStats.linked,
        programs_skipped: shaderStats.skipped,
        browser: browserLabel(),
      })
    },
  }
}

// --- How long the engine works on each frame -----------------------------------
// The engine draws one frame per animation-frame callback. Timing each callback
// tells a frame the engine was busy with apart from one spent waiting on the
// graphics card, for the run reports above (run_started resets, run_perf
// reads). Bounded: a run longer than ~5 minutes keeps its first frames.
const engineFrames = { busy: [] }
function measureEngineFrames() {
  if (window.__ballGameFrameTiming) return
  window.__ballGameFrameTiming = true
  const schedule = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = (callback) =>
    schedule((time) => {
      const start = performance.now()
      try {
        callback(time)
      } finally {
        if (engineFrames.busy.length < 20000) engineFrames.busy.push(performance.now() - start)
      }
    })
}

// Signals carry flat values only: engine_ms is "median/95th percentile/max"
// milliseconds, engine_long how many frames the engine worked longer than a
// 60 Hz refresh.
function engineFrameStats() {
  const busy = [...engineFrames.busy].sort((a, b) => a - b)
  if (!busy.length) return {}
  const at = (share) => busy[Math.min(busy.length - 1, Math.floor(busy.length * share))].toFixed(1)
  return { engine_ms: `${at(0.5)}/${at(0.95)}/${at(1)}`, engine_long: busy.filter((ms) => ms > 16.7).length }
}

// --- Graphics programs the game never draws with --------------------------------
// Godot's web renderer (Compatibility, Godot 4.7) compiles four variants of the
// 3D scene shader up front for every material it meets, one per drawing mode,
// with "default" settings (drivers/gles3/shader_gles3.cpp, _initialize_version).
// The game never draws with those: every render pass asks for a variant that
// says how lightmaps are handled (DISABLE_LIGHTMAP, USE_LIGHTMAP or
// USE_LIGHTMAP_CAPTURE), and the defaults say nothing about lightmaps. Browsers
// on Windows take a third of a second or more per program, and these were
// about half of all the game compiles, so each gets a tiny stand-in program
// instead. If a stand-in is ever drawn with (say a Godot upgrade changed the
// rule), the game reports it once. Re-check this when upgrading Godot.
const shaderStats = { linked: 0, skipped: 0, misused: false }
const LIGHTMAP_SETTING = /^#define (DISABLE_LIGHTMAP|USE_LIGHTMAP|USE_LIGHTMAP_CAPTURE)\b/m

function skipUnusedShaderVariants() {
  const proto = window.WebGL2RenderingContext?.prototype
  if (!proto || proto.__ballGameShaders) return
  proto.__ballGameShaders = true
  const { createShader, shaderSource, attachShader, linkProgram, useProgram } = proto
  const stages = new WeakMap()
  const standInShaders = new WeakSet()
  const standInPrograms = new WeakSet()
  proto.createShader = function (type) {
    const shader = createShader.call(this, type)
    if (shader) stages.set(shader, type)
    return shader
  }
  proto.shaderSource = function (shader, source) {
    if (typeof source === 'string' && source.includes('SceneDataBlock') && !LIGHTMAP_SETTING.test(source)) {
      standInShaders.add(shader)
      const version = source.startsWith('#version') ? source.slice(0, source.indexOf('\n') + 1) : '#version 300 es\n'
      source = stages.get(shader) === this.FRAGMENT_SHADER
        ? `${version}precision highp float;\nlayout(location = 0) out vec4 frag_color;\nvoid main() { frag_color = vec4(0.0); }\n`
        : `${version}void main() { gl_Position = vec4(0.0); }\n`
    }
    return shaderSource.call(this, shader, source)
  }
  proto.attachShader = function (program, shader) {
    if (standInShaders.has(shader)) standInPrograms.add(program)
    return attachShader.call(this, program, shader)
  }
  proto.linkProgram = function (program) {
    if (standInPrograms.has(program)) shaderStats.skipped += 1
    else shaderStats.linked += 1
    return linkProgram.call(this, program)
  }
  // Godot binds every new program to set it up, so binding one proves
  // nothing; drawing with a stand-in would.
  proto.useProgram = function (program) {
    this.__ballGameStandIn = Boolean(program) && standInPrograms.has(program)
    return useProgram.call(this, program)
  }
  for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
    const draw = proto[name]
    proto[name] = function (a, b, c, d, e, f) {
      if (this.__ballGameStandIn && !shaderStats.misused) {
        shaderStats.misused = true
        window.mobius?.signal('error', { source: 'shader_variant', message: 'A skipped graphics program was drawn with.' })
      }
      return draw.call(this, a, b, c, d, e, f)
    }
  }
}

// One engine per page: Godot's loader is a page-wide singleton, so a remounted
// component (or a second effect run) joins the start already in flight.
let gameStart = null
function startGameOnce(options) {
  if (!gameStart) gameStart = startGame(options)
  return gameStart
}

// --- Engine health -----------------------------------------------------------
// When the engine crashes, the only sign is an uncaught WebAssembly.RuntimeError
// ("unreachable executed") on this window: Godot doesn't wire emscripten's abort
// hook. The Möbius frame runtime handles window errors ahead of app listeners in
// the bubble phase, so these capture-phase listeners are installed when the module
// loads. Only engine traps count: ordinary rejections, such as Firefox refusing
// service-worker access, are not failures.
const engineHealth = { failure: null, listeners: new Set() }

function reportEngineFailure(kind, message) {
  if (engineHealth.failure) return
  engineHealth.failure = { kind, message }
  engineHealth.listeners.forEach((listener) => listener(engineHealth.failure))
}

function isEngineTrap(error, message) {
  return (typeof WebAssembly !== 'undefined' && error instanceof WebAssembly.RuntimeError)
    || /\bRuntimeError\b|\bunreachable\b|Aborted\(/.test(String(message || ''))
}

window.addEventListener('error', (event) => {
  if (isEngineTrap(event.error, event.message)) {
    reportEngineFailure('engine_crash', String(event.error?.message || event.message))
  }
}, true)
window.addEventListener('unhandledrejection', (event) => {
  if (isEngineTrap(event.reason, event.reason?.message)) {
    reportEngineFailure('engine_crash', String(event.reason?.message || event.reason))
  }
}, true)

// Browsers grant pointer lock only right after a click, and a refused request
// throws or rejects. Godot asks for it from inside the engine, where an uncaught
// error aborts the engine, so a refusal here is made harmless: the game keeps
// running and mouse-look falls back to dragging.
function makePointerLockSafe(canvas) {
  const request = canvas.requestPointerLock?.bind(canvas)
  if (!request) return
  canvas.requestPointerLock = (...args) => {
    try {
      const pending = request(...args)
      pending?.catch?.(() => {})
      return pending
    } catch {
      return undefined
    }
  }
}

// Godot asks for its service-worker registration at start-up even with PWA
// support off. This opaque frame may not use service workers, and Firefox
// rejects the query with "The operation is insecure"; report "no registration".
function quietServiceWorkerQuery() {
  try {
    const container = navigator.serviceWorker
    if (!container?.getRegistration) return
    // This frame has an opaque origin, so it can never own a service worker;
    // Firefox logs a console error merely for being asked. Answer "none" directly.
    container.getRegistration = () => Promise.resolve(undefined)
  } catch {
    // No service-worker access at all; Godot checks for it before asking.
  }
}

// Coarse browser and OS for diagnostics ("Firefox 143 · Windows").
function browserLabel() {
  const ua = navigator.userAgent
  const browser = [/Firefox\/(\d+)/, /Edg\/(\d+)/, /Chrome\/(\d+)/, /Version\/(\d+).*Safari/]
    .map((pattern, i) => [['Firefox', 'Edge', 'Chrome', 'Safari'][i], ua.match(pattern)])
    .find(([, match]) => match)
  const os = ['Windows', 'Android', 'iPhone', 'iPad', 'Mac OS X', 'CrOS', 'Linux'].find((name) => ua.includes(name)) || 'other'
  return `${browser ? `${browser[0]} ${browser[1][1]}` : 'unknown'} · ${os === 'Mac OS X' ? 'macOS' : os}`
}

async function startGame({ appId, canvas, onProgress, onEngineLog }) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot unpack the game engine. Use a current Chrome, Edge, Firefox or Safari.')
  }
  const base = `/app-assets/by-id/${appId}/web/`
  const response = await fetch(`${base}config.json`)
  if (!response.ok) throw new Error(`Game files are missing (config.json: ${response.status}).`)
  const config = await response.json()
  serveCompressedFiles(base, config.compressed || {})
  exposeLevelPacks(base, config.packSizes || {})
  makePointerLockSafe(canvas)
  skipUnusedShaderVariants()
  measureEngineFrames()
  quietServiceWorkerQuery()
  await exposeStore(window.mobius?.storage)
  exposeCommunity()
  exposeParty()
  exposeHost()
  await loadScript(`${base}${config.executable}.js`)

  const executable = base + config.executable
  const mainPack = base + config.mainPack
  const engine = new window.Engine({
    args: config.args,
    canvasResizePolicy: config.canvasResizePolicy,
    emscriptenPoolSize: config.emscriptenPoolSize,
    godotPoolSize: config.godotPoolSize,
    experimentalVK: config.experimentalVK,
    gdextensionLibs: config.gdextensionLibs,
    ensureCrossOriginIsolationHeaders: false,
    focusCanvas: config.focusCanvas,
    canvas,
    executable,
    mainPack,
    fileSizes: {
      [`${executable}.wasm`]: config.fileSizes[`${config.executable}.wasm`],
      [mainPack]: config.fileSizes[config.mainPack],
    },
    persistentPaths: [],
    onProgress,
    onPrint: (...parts) => onEngineLog(parts.join(' ')),
    onPrintError: (...parts) => onEngineLog(parts.join(' ')),
  })
  levelPacks.engine = engine
  await engine.startGame()
  return engine
}

// Themed levels are separate resource packs beside the engine files. The game
// asks for one the first time its level is played (level_loader.gd); the page
// downloads it with progress and writes it into the engine's in-memory file
// system, where the game mounts it. (This frame has no persistent storage for
// the engine's own downloads.)
const levelPacks = { engine: null, states: new Map(), sizes: {} }

function exposeLevelPacks(base, sizes) {
  levelPacks.sizes = sizes
  window.ballGameAssets = {
    base_url: new URL(base, window.location.href).href,
    fetch_pack(name) {
      const pack = String(name)
      const known = levelPacks.states.get(pack)
      if (!/^[A-Za-z0-9_.-]+\.pck$/.test(pack) || known?.status === 'loading' || known?.status === 'ready') return
      fetchLevelPack(base, pack)
    },
    pack_state(name) {
      return JSON.stringify(levelPacks.states.get(String(name)) || { status: 'none' })
    },
  }
}

async function fetchLevelPack(base, name) {
  const state = { status: 'loading', received: 0, total: 0 }
  levelPacks.states.set(name, state)
  try {
    const response = await fetch(base + name)
    if (!response.ok) throw new Error(`The level download failed (${response.status}).`)
    state.total = Number(response.headers.get('content-length')) || Number(levelPacks.sizes?.[name]) || 0
    const reader = response.body.getReader()
    const chunks = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      state.received += value.length
    }
    const bytes = new Uint8Array(state.received)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    const path = `/tmp/ball-game/${name}`
    levelPacks.engine.copyToFS(path, bytes)
    Object.assign(state, { status: 'ready', path })
  } catch (err) {
    Object.assign(state, { status: 'error', message: String(err?.message || err) })
    window.mobius?.signal('error', { source: 'level_pack', message: state.message.slice(0, 300) })
  }
}

// A start makes visible progress (download, engine log lines) until the game
// runs. Compiling ~40 MB of WebAssembly can go quiet for a while on slow
// machines, so silence first offers a retry and only later counts as failure.
const STALL_HINT_MS = 15000
const STALL_LIMIT_MS = 45000

const FAILURE_TEXT = {
  engine_start: 'The game could not start.',
  start_stall: 'The game stopped responding while starting.',
  engine_crash: 'The game engine stopped unexpectedly.',
  graphics_lost: 'The browser reset the game’s graphics.',
}

export default function BallGame({ appId, token }) {
  communityAuth.appId = appId
  communityAuth.token = token
  const canvasRef = useRef(null)
  const phaseRef = useRef('loading')
  const [engineLine, setEngineLine] = useState('')
  const [phase, setPhaseState] = useState('loading')
  const [progress, setProgress] = useState(0)
  const [failure, setFailure] = useState(null)
  const [slow, setSlow] = useState(false)
  const [focused, setFocused] = useState(false)
  const [touchOnly] = useState(() => window.matchMedia?.('(hover: none) and (pointer: coarse)').matches)

  useEffect(() => {
    const post = (value) => window.parent.postMessage({ type: 'moebius:immersive', value, appId }, '*')
    post(true)
    return () => post(false)
  }, [appId])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !appId) return undefined
    let cancelled = false
    let lastLine = ''
    let lastShare = 0
    let lastActivity = performance.now()
    const startedAt = performance.now()
    const browser = browserLabel()
    const setPhase = (next) => {
      phaseRef.current = next
      setPhaseState(next)
    }
    const fail = ({ kind, message }) => {
      if (cancelled || phaseRef.current === 'error') return
      const failedDuring = phaseRef.current
      setFailure({ kind, message })
      setPhase('error')
      window.mobius?.signal('error', {
        source: kind,
        message: String(message).slice(0, 300),
        phase: failedDuring,
        downloaded: Math.round(lastShare * 100),
        last_engine_line: lastLine.slice(0, 200),
        seconds: Math.round((performance.now() - startedAt) / 1000),
        browser,
      })
    }
    engineHealth.listeners.add(fail)
    if (engineHealth.failure) fail(engineHealth.failure)
    const onContextLost = () => reportEngineFailure('graphics_lost', 'WebGL context lost')
    const onFocus = () => setFocused(true)
    const onBlur = () => setFocused(false)
    canvas.addEventListener('webglcontextlost', onContextLost)
    canvas.addEventListener('focus', onFocus)
    canvas.addEventListener('blur', onBlur)
    const watchdog = window.setInterval(() => {
      if (phaseRef.current !== 'loading' && phaseRef.current !== 'starting') return
      const quiet = performance.now() - lastActivity
      setSlow(quiet > STALL_HINT_MS)
      if (quiet > STALL_LIMIT_MS) fail({ kind: 'start_stall', message: `No progress for ${Math.round(quiet / 1000)} s` })
    }, 1000)

    startGameOnce({
      appId,
      canvas,
      onProgress: (current, total) => {
        if (cancelled || !total) return
        lastActivity = performance.now()
        const share = Math.min(current / total, 1)
        lastShare = share
        setProgress(share)
        if (share >= 1 && phaseRef.current === 'loading') setPhase('starting')
      },
      onEngineLog: (line) => {
        if (cancelled || !line.trim()) return
        lastActivity = performance.now()
        lastLine = line.trim()
        setEngineLine(lastLine.slice(0, 160))
      },
    }).then(() => {
      if (cancelled || phaseRef.current === 'error') return
      setPhase('ready')
      setFocused(document.activeElement === canvas)
      window.mobius?.signal('app_ready', {
        engine: 'godot-web',
        seconds: Math.round((performance.now() - startedAt) / 1000),
        programs: shaderStats.linked,
        programs_skipped: shaderStats.skipped,
        browser,
      })
    }).catch((err) => fail({ kind: 'engine_start', message: String(err?.message || err) }))

    return () => {
      cancelled = true
      engineHealth.listeners.delete(fail)
      window.clearInterval(watchdog)
      canvas.removeEventListener('webglcontextlost', onContextLost)
      canvas.removeEventListener('focus', onFocus)
      canvas.removeEventListener('blur', onBlur)
    }
  }, [appId])

  const percent = Math.round(progress * 100)
  const retry = (
    <button type="button" className="bg-button" onClick={() => window.location.reload()}>
      Try again
    </button>
  )

  return (
    <div className="bg-root">
      <style>{CSS}</style>
      <canvas
        ref={canvasRef}
        id="canvas"
        className={`bg-canvas${phase === 'ready' ? ' is-live' : ''}`}
        tabIndex={0}
        aria-label="Ball Game"
        onContextMenu={(event) => event.preventDefault()}
      />
      {phase === 'ready' && !focused && <div className="bg-hint">Click to play</div>}
      {phase === 'ready' && party && <PartyOverlay party={party} />}
      {phase === 'ready' && touchOnly && (
        <div className="bg-note">Ball Game is played with a keyboard and mouse, or a gamepad.</div>
      )}
      {phase !== 'ready' && (
        <div className="bg-cover" role="status" aria-live="polite">
          <div className="bg-card">
            <div className="bg-stage" aria-hidden="true">
              <div className="bg-track" />
              <div className="bg-ball" />
            </div>
            <h1 className="bg-title">Ball Game</h1>
            {phase === 'error' ? (
              <>
                <p className="bg-error">{FAILURE_TEXT[failure?.kind] || FAILURE_TEXT.engine_start}</p>
                {(failure?.message || engineLine) && (
                  <p className="bg-detail">{failure?.message}{engineLine ? ` · ${engineLine}` : ''}</p>
                )}
                {retry}
              </>
            ) : (
              <>
                <p className="bg-status">
                  {phase === 'starting' ? 'Starting the engine…' : `Loading the engine… ${percent}%`}
                </p>
                <div className="bg-bar" aria-hidden="true">
                  <span style={{ width: `${phase === 'starting' ? 100 : percent}%` }} />
                </div>
                {phase === 'starting' && engineLine && <p className="bg-detail">{engineLine}</p>}
                {slow && (
                  <>
                    <p className="bg-detail">This is taking longer than usual.</p>
                    {retry}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
