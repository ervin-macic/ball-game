import React, { useEffect, useState } from 'react'

// Party mode: several players race the same levels at the same time and
// collect points per level; a podium crowns the top three at the end.
//
// Players meet in a Möbius live room (window.mobius.live) named after a party
// code. The player who hosts the party is authoritative: it keeps the party's
// state (phase, round, level, start time, finishes, points) and broadcasts a
// snapshot whenever it changes; every other player adopts the snapshot. Each
// player also broadcasts its ball's position ~15 times a second so the others
// can draw it.
//
// The game (ball-game/scripts/party/party_client.gd) talks to this file through
// window.ballGameParty: it polls state() and remotes() and reports pose(),
// loaded() and finish(). Everything that is shown around the race (lobby,
// countdown, standings, results, podium) is drawn here, over the canvas.

export const PARTY_LEVELS = [
  { id: 'beach', title: 'Beach Boardwalk' },
  { id: 'jungle', title: 'Forest' },
  { id: 'winter', title: 'Winter Wonderland' },
  { id: 'test_track', title: 'Tutorial Level' },
]
const DEFAULT_LEVELS = ['beach', 'jungle', 'winter']
// Points for 1st, 2nd, …; everyone else who finishes gets 1, a missed finish 0.
export const POINTS = [10, 8, 6, 5, 4, 3, 2, 1]
const COLORS = ['#ff5a5f', '#2ec4b6', '#ffbe0b', '#8338ec', '#3a86ff', '#fb5607', '#06d6a0', '#ff006e',
  '#8ac926', '#f15bb5', '#00bbf9', '#e76f51', '#9b5de5', '#43aa8b', '#f9c74f', '#577590']
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
// Seconds: waiting for everyone's level to load, the countdown, how long the
// others get after the first finish, and the longest a round can last.
const LOAD_WAIT = 25
const COUNTDOWN = 4
const CLOSE_AFTER_FIRST = 30
const ROUND_CAP = 300
const POSE_STALE = 3

const levelTitle = (id) => PARTY_LEVELS.find((level) => level.id === id)?.title || id

export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '—'
  const millis = Math.round(seconds * 1000)
  const minutes = Math.floor(millis / 60000)
  const rest = (millis % 60000) / 1000
  return `${minutes}:${rest.toFixed(3).padStart(6, '0')}`
}

// One round's placings: finishers by time, then everyone who didn't finish.
export function scoreRound(entrants, finishes) {
  const finished = entrants.filter((pid) => Number.isFinite(finishes[pid]))
    .sort((a, b) => finishes[a] - finishes[b])
  const missed = entrants.filter((pid) => !Number.isFinite(finishes[pid]))
  return [
    ...finished.map((pid, i) => ({ pid, time: finishes[pid], points: POINTS[i] ?? 1 })),
    ...missed.map((pid) => ({ pid, time: null, points: 0 })),
  ]
}

// The final standings: most points first, then most wins, then the lowest total
// time over the levels a player finished.
export function standings(state) {
  const rows = Object.keys(state.players).map((pid) => {
    let wins = 0
    let time = 0
    let finished = 0
    for (const round of state.history) {
      const row = round.results.find((r) => r.pid === pid)
      if (!row) continue
      if (row === round.results[0] && row.time != null) wins += 1
      if (row.time != null) {
        time += row.time
        finished += 1
      }
    }
    return { pid, points: state.totals[pid] || 0, wins, time, finished }
  }).filter((row) => row.points > 0 || state.history.some((round) => round.results.some((r) => r.pid === row.pid)))
  rows.sort((a, b) => b.points - a.points || b.wins - a.wins || b.finished - a.finished || a.time - b.time)
  return rows
}

function newCode() {
  let code = ''
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  for (const byte of bytes) code += CODE_LETTERS[byte % CODE_LETTERS.length]
  return code
}

// --- The party itself ---------------------------------------------------------

export function createParty({ live }) {
  // This page's player id: stays the same across reconnects (members get new ids).
  const pid = Math.random().toString(36).slice(2, 10)
  const listeners = new Set()
  let room = null
  let roomStatus = 'closed'
  let members = []
  let state = null // the host's snapshot
  let isHost = false
  let name = ''
  let error = ''
  let version = 0
  let gameLevel = ''
  const memberPid = new Map() // member id -> player id
  const poses = new Map() // player id -> { lv, p, q, v, d, at }
  let timers = []
  let loadingSince = 0

  const changed = () => {
    version += 1
    listeners.forEach((listener) => listener())
  }
  const now = () => (room ? room.serverNow() : Date.now() / 1000)

  const publish = () => {
    if (!isHost || !state) return
    state = { ...state, v: (state.v || 0) + 1 }
    room?.send({ t: 'state', state, pid })
    changed()
  }

  const here = () => {
    const present = new Set(members.map((member) => memberPid.get(member.id)).filter(Boolean))
    present.add(pid)
    return present
  }

  const markPresence = () => {
    if (!isHost || !state) return
    const present = here()
    let moved = false
    const players = { ...state.players }
    for (const [id, player] of Object.entries(players)) {
      const isHere = present.has(id)
      if (player.here !== isHere) {
        players[id] = { ...player, here: isHere }
        moved = true
      }
    }
    if (moved) {
      state = { ...state, players }
      checkRound()
      publish()
    }
  }

  // --- Host rules ---
  const addPlayer = (id, playerName) => {
    if (!state) return
    const known = state.players[id]
    const cleanName = String(playerName || 'Player').slice(0, 24)
    if (known && known.name === cleanName && known.here) return
    const used = new Set(Object.values(state.players).map((p) => p.color))
    const color = known?.color || COLORS.find((c) => !used.has(c)) || COLORS[Object.keys(state.players).length % COLORS.length]
    state = { ...state, players: { ...state.players, [id]: { name: cleanName, color, here: true } } }
    publish()
  }

  const startRound = (index) => {
    const level = state.settings.levels[index]
    const entrants = [...here()].filter((id) => state.players[id])
    loadingSince = now()
    state = { ...state, phase: 'loading', round: index, level, entrants, loaded: [], finishes: {}, go_at: null, close_at: null }
    publish()
  }

  const go = () => {
    const goAt = now() + COUNTDOWN
    state = { ...state, phase: 'racing', go_at: goAt, close_at: goAt + ROUND_CAP }
    publish()
  }

  const endRound = () => {
    const results = scoreRound(state.entrants, state.finishes)
    const totals = { ...state.totals }
    for (const row of results) totals[row.pid] = (totals[row.pid] || 0) + row.points
    state = { ...state, phase: 'results', history: [...state.history, { level: state.level, results }], totals, go_at: null, close_at: null }
    publish()
  }

  // Closes a round early once everyone still here has finished.
  const checkRound = () => {
    if (state?.phase === 'loading') {
      const waiting = state.entrants.filter((id) => state.players[id]?.here && !state.loaded.includes(id))
      if (waiting.length === 0) go()
    } else if (state?.phase === 'racing') {
      const racing = state.entrants.filter((id) => state.players[id]?.here && !Number.isFinite(state.finishes[id]))
      if (racing.length === 0 && Object.keys(state.finishes).length > 0) {
        state = { ...state, close_at: Math.min(state.close_at, now() + 2) }
      }
    }
  }

  const hostHandle = (from, message) => {
    if (message.t === 'hello') {
      addPlayer(from, message.name)
    } else if (message.t === 'loaded' && state.phase === 'loading' && message.round === state.round) {
      if (!state.loaded.includes(from)) {
        state = { ...state, loaded: [...state.loaded, from] }
        checkRound()
        publish()
      }
    } else if (message.t === 'finish' && state.phase === 'racing' && message.round === state.round) {
      const time = Number(message.time)
      if (!state.entrants.includes(from) || Number.isFinite(state.finishes[from]) || !(time > 0)) return
      const first = Object.keys(state.finishes).length === 0
      state = {
        ...state,
        finishes: { ...state.finishes, [from]: time },
        close_at: first ? Math.min(state.close_at, now() + CLOSE_AFTER_FIRST) : state.close_at,
      }
      checkRound()
      publish()
    }
  }

  const hostTick = () => {
    if (!isHost || !state) return
    if (state.phase === 'loading' && now() - loadingSince > LOAD_WAIT) go()
    else if (state.phase === 'racing' && now() >= state.close_at) endRound()
  }

  // --- Everyone ---
  const handle = (from, message) => {
    if (!message || typeof message !== 'object') return
    if (message.t === 'pose') {
      poses.set(from, { ...message, at: performance.now() })
      return
    }
    if (message.t === 'state' && !isHost) {
      const next = message.state
      if (next && (!state || next.host !== state.host || (next.v || 0) >= (state.v || 0))) {
        const roundChanged = !state || state.round !== next.round || state.phase !== next.phase
        state = next
        if (roundChanged && next.phase === 'loading') focusGame()
        changed()
      }
      return
    }
    if (isHost) hostHandle(from, message)
  }

  const send = (message) => {
    if (isHost) hostHandle(pid, message)
    room?.send({ ...message, pid })
  }

  const open = (code, asHost, playerName) => {
    leave()
    name = String(playerName || '').trim().slice(0, 24)
    error = ''
    isHost = asHost
    state = asHost ? {
      v: 0,
      code,
      host: pid,
      phase: 'lobby',
      settings: { levels: [...DEFAULT_LEVELS], collisions: true },
      round: -1,
      level: '',
      entrants: [],
      loaded: [],
      finishes: {},
      go_at: null,
      close_at: null,
      players: {},
      history: [],
      totals: {},
    } : null
    const joined = live.join(`party-${code}`, { name: name || undefined })
    room = joined
    roomStatus = room.status
    if (!asHost) {
      // Any code opens a room; a party only exists where a host answers.
      timers.push(setTimeout(() => {
        if (room !== joined || state) return
        leave()
        error = `No party is running with the code ${code}.`
        changed()
      }, 6000))
    }
    room.onStatus((status) => {
      roomStatus = status
      if (status === 'open') {
        const youName = name || room.you?.name || 'Player'
        if (isHost) addPlayer(pid, youName)
        room.send({ t: 'hello', pid, name: youName })
        room.sync()
      } else if (status === 'error' && !state) {
        leave()
        error = 'That party could not be joined — it may be full.'
      }
      changed()
    })
    room.onPresence((list) => {
      members = list
      markPresence()
      changed()
    })
    room.onMessage(({ from, data }) => {
      if (!data || typeof data !== 'object') return
      const id = typeof data.pid === 'string' ? data.pid : null
      if (!id) return
      memberPid.set(from, id)
      if (data.t === 'hello') {
        if (isHost) {
          hostHandle(id, data)
          markPresence()
          room.send({ t: 'state', state, pid }, [from])
        }
        changed()
        return
      }
      handle(id, data)
    })
    timers.push(
      setInterval(hostTick, 250),
      // A heartbeat snapshot repairs anything a dropped message missed.
      setInterval(() => { if (isHost && state) room?.send({ t: 'state', state, pid }) }, 3000),
      setInterval(() => { if (!isHost) room?.sync() }, 15000),
    )
    changed()
  }

  function leave() {
    timers.forEach((timer) => { clearInterval(timer); clearTimeout(timer) })
    timers = []
    room?.close()
    room = null
    roomStatus = 'closed'
    members = []
    state = null
    isHost = false
    poses.clear()
    memberPid.clear()
    changed()
  }

  const hostAction = (fn) => (...args) => {
    if (!isHost || !state) return
    fn(...args)
  }

  const controls = {
    host: (playerName) => open(newCode(), true, playerName),
    join: (code, playerName) => open(String(code).trim().toUpperCase(), false, playerName),
    leave,
    setLevels: hostAction((levels) => {
      if (state.phase !== 'lobby') return
      state = { ...state, settings: { ...state.settings, levels } }
      publish()
    }),
    setCollisions: hostAction((collisions) => {
      state = { ...state, settings: { ...state.settings, collisions: !!collisions } }
      publish()
    }),
    start: hostAction(() => {
      if (state.phase !== 'lobby' || state.settings.levels.length === 0) return
      state = { ...state, history: [], totals: {} }
      startRound(0)
      focusGame()
    }),
    next: hostAction(() => {
      if (state.phase !== 'results') return
      if (state.round + 1 < state.settings.levels.length) {
        startRound(state.round + 1)
        focusGame()
      } else {
        state = { ...state, phase: 'podium' }
        publish()
      }
    }),
    endRoundNow: hostAction(() => {
      if (state.phase === 'racing') endRound()
    }),
    again: hostAction(() => {
      state = { ...state, phase: 'lobby', round: -1, level: '', history: [], totals: {}, entrants: [], finishes: {}, loaded: [] }
      publish()
    }),
  }

  // The game's side (party_client.gd). Called every frame; keep it cheap.
  const bridge = {
    state() {
      if (!state) return JSON.stringify({ active: false, version })
      return JSON.stringify({
        active: true,
        version,
        phase: state.phase,
        round: state.round,
        level: state.level,
        go_in: state.go_at == null ? null : state.go_at - now(),
        entrant: state.entrants.includes(pid),
        finished: Number.isFinite(state.finishes[pid]),
        collisions: !!state.settings.collisions,
        you: pid,
        color: state.players[pid]?.color || '#ffffff',
      })
    },
    remotes(level) {
      if (!state) return '[]'
      const out = []
      const t = performance.now()
      for (const [id, pose] of poses) {
        const player = state.players[id]
        const age = (t - pose.at) / 1000
        if (id === pid || !player?.here || pose.lv !== String(level) || age > POSE_STALE) continue
        out.push({ pid: id, name: player.name, color: player.color, p: pose.p, q: pose.q, v: pose.v, age })
      }
      return JSON.stringify(out)
    },
    pose(text) {
      if (!room || !state) return
      let pose
      try { pose = JSON.parse(String(text)) } catch { return }
      gameLevel = pose.lv
      poses.set(pid, { ...pose, at: performance.now() })
      room.send({ t: 'pose', pid, lv: pose.lv, p: pose.p, q: pose.q, v: pose.v, d: pose.d })
    },
    loaded(level, round) {
      gameLevel = String(level)
      if (state && state.level === String(level) && state.round === Number(round)) send({ t: 'loaded', round: Number(round) })
    },
    finish(time, round) {
      if (state && state.round === Number(round)) send({ t: 'finish', round: Number(round), time: Number(time) })
    },
  }

  return {
    pid,
    bridge,
    controls,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: () => ({ version, state, isHost, roomStatus, members, error, pid, gameLevel, joining: !!room && !state }),
    progressOf: (id) => poses.get(id)?.d ?? 0,
    now,
  }
}

function focusGame() {
  // Racing needs the keyboard: hand it back to the game after a button press.
  setTimeout(() => document.getElementById('canvas')?.focus(), 50)
}

// --- What's drawn over the game ---------------------------------------------

export const PARTY_CSS = `
  .pt-layer { position: absolute; inset: 0; pointer-events: none; font-family: var(--font); color: #fff; }
  .pt-layer button, .pt-layer input, .pt-card, .pt-panel, .pt-chip { pointer-events: auto; }
  .pt-chip {
    position: absolute; top: max(14px, var(--mobius-safe-top, 0px)); right: 14px;
    display: inline-flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 16px;
    border-radius: 999px; border: 1px solid rgba(255,255,255,0.22); background: rgba(8,12,20,0.72);
    color: #fff; font: inherit; font-weight: 700; cursor: pointer; backdrop-filter: blur(6px);
  }
  .pt-chip:hover { background: rgba(20,28,44,0.85); }
  .pt-chip:focus-visible, .pt-btn:focus-visible, .pt-input:focus-visible, .pt-toggle:focus-visible { outline: 3px solid #ffd166; outline-offset: 2px; }
  .pt-scrim { position: absolute; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(5,8,14,0.55); pointer-events: auto; }
  .pt-card {
    width: min(440px, 100%); max-height: calc(100% - 40px); overflow: auto; padding: 22px; border-radius: 20px;
    background: rgba(14,20,32,0.94); border: 1px solid rgba(255,255,255,0.14); box-shadow: 0 24px 60px rgba(0,0,0,0.45);
  }
  .pt-card.is-wide { width: min(560px, 100%); }
  .pt-card h2 { margin: 0 0 4px; font-size: 1.4rem; letter-spacing: -0.02em; }
  .pt-sub { margin: 0 0 16px; color: rgba(255,255,255,0.68); font-size: 0.92rem; line-height: 1.45; }
  .pt-row { display: flex; gap: 10px; align-items: center; }
  .pt-row + .pt-row, .pt-field + .pt-row, .pt-row + .pt-field { margin-top: 12px; }
  .pt-field { display: grid; gap: 6px; }
  .pt-field label { font-size: 0.8rem; font-weight: 700; color: rgba(255,255,255,0.7); text-transform: uppercase; letter-spacing: 0.06em; }
  .pt-input {
    min-height: 44px; padding: 0 14px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.2);
    background: rgba(255,255,255,0.06); color: #fff; font: inherit; font-size: 1rem; width: 100%; box-sizing: border-box;
  }
  .pt-input.is-code { text-transform: uppercase; letter-spacing: 0.3em; font-weight: 800; text-align: center; }
  .pt-btn {
    min-height: 44px; padding: 0 18px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.22);
    background: rgba(255,255,255,0.08); color: #fff; font: inherit; font-weight: 700; cursor: pointer; white-space: nowrap;
  }
  .pt-btn.is-main { background: #ffd166; border-color: #ffd166; color: #1b1405; }
  .pt-btn:disabled { opacity: 0.45; cursor: default; }
  .pt-grow { flex: 1; }
  .pt-divider { margin: 18px 0 14px; height: 1px; background: rgba(255,255,255,0.12); }
  .pt-error { margin: 12px 0 0; color: #ff9b9b; font-size: 0.9rem; }
  .pt-panel {
    position: absolute; top: max(14px, var(--mobius-safe-top, 0px)); right: 14px; width: min(320px, calc(100% - 28px));
    max-height: calc(100% - 28px); overflow: auto; padding: 16px; border-radius: 18px; box-sizing: border-box;
    background: rgba(10,15,25,0.86); border: 1px solid rgba(255,255,255,0.14); backdrop-filter: blur(8px);
  }
  .pt-code { font-size: 2rem; font-weight: 850; letter-spacing: 0.22em; margin: 2px 0 2px; }
  .pt-label { font-size: 0.75rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(255,255,255,0.6); margin: 14px 0 6px; }
  .pt-players { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .pt-players li { display: flex; align-items: center; gap: 8px; font-weight: 650; }
  .pt-players li.is-away { opacity: 0.45; }
  .pt-dot { width: 12px; height: 12px; border-radius: 50%; flex: none; box-shadow: 0 0 0 2px rgba(255,255,255,0.25); }
  .pt-tag { margin-left: auto; font-size: 0.72rem; font-weight: 800; padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,0.12); color: rgba(255,255,255,0.8); }
  .pt-toggle {
    display: flex; align-items: center; gap: 10px; width: 100%; min-height: 40px; padding: 0 12px; border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.04); color: #fff; font: inherit; cursor: pointer; text-align: left;
  }
  .pt-toggle + .pt-toggle { margin-top: 6px; }
  .pt-toggle[aria-pressed="true"] { border-color: #ffd166; background: rgba(255,209,102,0.12); }
  .pt-box { width: 18px; height: 18px; border-radius: 5px; border: 2px solid rgba(255,255,255,0.5); display: grid; place-items: center; font-size: 12px; font-weight: 900; flex: none; }
  .pt-toggle[aria-pressed="true"] .pt-box { background: #ffd166; border-color: #ffd166; color: #1b1405; }
  .pt-order { margin-left: auto; font-size: 0.8rem; color: #ffd166; font-weight: 800; }
  .pt-note { margin: 10px 0 0; font-size: 0.82rem; color: rgba(255,255,255,0.6); line-height: 1.4; }
  .pt-banner {
    position: absolute; top: max(14px, var(--mobius-safe-top, 0px)); left: 50%; transform: translateX(-50%); margin-top: 64px;
    padding: 10px 18px; border-radius: 999px; background: rgba(8,12,20,0.78); font-weight: 750; white-space: nowrap; max-width: calc(100% - 32px);
    overflow: hidden; text-overflow: ellipsis;
  }
  .pt-count {
    position: absolute; left: 50%; top: 38%; transform: translate(-50%, -50%);
    font-size: clamp(5rem, 18vw, 11rem); font-weight: 900; letter-spacing: -0.04em; color: #fff;
    text-shadow: 0 6px 0 rgba(0,0,0,0.25), 0 0 40px rgba(0,0,0,0.35); animation: pt-pop 1s ease-out infinite;
  }
  .pt-count.is-go { color: #ffd166; animation: none; }
  @keyframes pt-pop { 0% { transform: translate(-50%, -50%) scale(1.25); opacity: 0.6; } 25% { transform: translate(-50%, -50%) scale(1); opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .pt-count { animation: none; } }
  .pt-standings { position: absolute; top: max(70px, var(--mobius-safe-top, 0px)); right: 14px; display: grid; gap: 4px; min-width: 200px; }
  .pt-standings div { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 10px; background: rgba(8,12,20,0.66); font-size: 0.88rem; font-weight: 700; }
  .pt-standings .is-you { outline: 2px solid rgba(255,255,255,0.55); }
  .pt-standings span:last-child { margin-left: auto; font-variant-numeric: tabular-nums; color: rgba(255,255,255,0.8); }
  .pt-place { width: 1.4em; color: rgba(255,255,255,0.6); font-variant-numeric: tabular-nums; }
  .pt-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  .pt-table th { text-align: left; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: rgba(255,255,255,0.55); padding: 6px 6px; }
  .pt-table td { padding: 8px 6px; border-top: 1px solid rgba(255,255,255,0.08); font-weight: 650; }
  .pt-table td.is-num, .pt-table th.is-num { text-align: right; }
  .pt-table tr.is-you td { color: #ffd166; }
  .pt-gain { color: #7ee2a8; }
  .pt-podium { display: grid; grid-template-columns: 1fr 1fr 1fr; align-items: end; gap: 10px; margin: 18px 0 8px; }
  .pt-step { display: grid; justify-items: center; gap: 6px; text-align: center; }
  .pt-step .pt-name { font-weight: 800; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pt-step .pt-pts { font-size: 0.85rem; color: rgba(255,255,255,0.7); }
  .pt-block { width: 100%; border-radius: 12px 12px 4px 4px; display: grid; place-items: center; font-size: 2rem; font-weight: 900; color: rgba(0,0,0,0.55); }
  .pt-ball { width: 44px; height: 44px; border-radius: 50%; box-shadow: inset -8px -8px 0 rgba(0,0,0,0.18), 0 0 0 3px rgba(255,255,255,0.3); }
  .pt-crown { font-size: 1.8rem; line-height: 1; animation: pt-bob 1.6s ease-in-out infinite; }
  @keyframes pt-bob { 50% { transform: translateY(-5px); } }
  @media (prefers-reduced-motion: reduce) { .pt-crown { animation: none; } }
`

function useParty(party) {
  const [, setTick] = useState(0)
  useEffect(() => party?.subscribe(() => setTick((n) => n + 1)), [party])
  return party?.snapshot()
}

// Re-renders a few times a second while something on screen counts down.
function useClock(active) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => setTick((n) => n + 1), 100)
    return () => clearInterval(timer)
  }, [active])
}

function Dot({ color }) {
  return <span className="pt-dot" style={{ background: color }} aria-hidden="true" />
}

function StartCard({ party, snap, onClose }) {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const joining = snap.joining
  const failed = !snap.state && !joining && snap.error
  return (
    <div className="pt-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pt-card" role="dialog" aria-modal="true" aria-labelledby="pt-start-title">
        <h2 id="pt-start-title">Party</h2>
        <p className="pt-sub">Race the same levels together. Every level hands out points — 10 for a win, then 8, 6, 5… — and the top three take the podium.</p>
        <div className="pt-field">
          <label htmlFor="pt-name">Your name</label>
          <input id="pt-name" className="pt-input" maxLength={24} value={name} placeholder="Name shown over your ball"
            onChange={(e) => setName(e.target.value)} autoComplete="nickname" />
        </div>
        <div className="pt-row">
          <button type="button" className="pt-btn is-main pt-grow" onClick={() => party.controls.host(name)}>Host a party</button>
        </div>
        <div className="pt-divider" />
        <div className="pt-field">
          <label htmlFor="pt-code">Join with a code</label>
          <div className="pt-row">
            <input id="pt-code" className="pt-input is-code pt-grow" maxLength={4} value={code} placeholder="CODE"
              onChange={(e) => setCode(e.target.value.replace(/[^a-z0-9]/gi, '').toUpperCase())}
              onKeyDown={(e) => { if (e.key === 'Enter' && code.length === 4) party.controls.join(code, name) }} />
            <button type="button" className="pt-btn" disabled={code.length !== 4 || joining} onClick={() => party.controls.join(code, name)}>
              {joining ? 'Joining…' : 'Join'}
            </button>
          </div>
        </div>
        {failed && <p className="pt-error" role="alert">{snap.error}</p>}
        <div className="pt-row" style={{ marginTop: 18 }}>
          <button type="button" className="pt-btn pt-grow" onClick={onClose}>Back to solo</button>
        </div>
      </div>
    </div>
  )
}

function PlayerList({ state, pid }) {
  const players = Object.entries(state.players)
  return (
    <ul className="pt-players">
      {players.map(([id, player]) => (
        <li key={id} className={player.here ? '' : 'is-away'}>
          <Dot color={player.color} />
          <span>{player.name}{id === pid ? ' (you)' : ''}</span>
          {id === state.host && <span className="pt-tag">host</span>}
          {!player.here && <span className="pt-tag">away</span>}
        </li>
      ))}
    </ul>
  )
}

function Lobby({ party, snap }) {
  const { state, isHost, pid } = snap
  const chosen = state.settings.levels
  const toggle = (id) => {
    const next = chosen.includes(id) ? chosen.filter((level) => level !== id) : [...chosen, id]
    party.controls.setLevels(next)
  }
  return (
    <div className="pt-panel" aria-label="Party lobby">
      <div className="pt-label" style={{ marginTop: 0 }}>Party code</div>
      <div className="pt-code">{state.code}</div>
      <p className="pt-note" style={{ marginTop: 0 }}>Friends open Ball Game, choose Party → Join and type this code.</p>
      <div className="pt-label">Players · {Object.values(state.players).filter((p) => p.here).length}</div>
      <PlayerList state={state} pid={pid} />
      <div className="pt-label">Levels{isHost ? ' · in the order you pick them' : ''}</div>
      {isHost ? PARTY_LEVELS.map((level) => {
        const at = chosen.indexOf(level.id)
        return (
          <button key={level.id} type="button" className="pt-toggle" aria-pressed={at >= 0} onClick={() => toggle(level.id)}>
            <span className="pt-box" aria-hidden="true">{at >= 0 ? '✓' : ''}</span>
            {level.title}
            {at >= 0 && <span className="pt-order">{at + 1}</span>}
          </button>
        )
      }) : (
        <p className="pt-note" style={{ marginTop: 0 }}>{chosen.map(levelTitle).join(' → ') || 'None picked yet'}</p>
      )}
      <div className="pt-label">Bumping</div>
      {isHost ? (
        <button type="button" className="pt-toggle" aria-pressed={state.settings.collisions} onClick={() => party.controls.setCollisions(!state.settings.collisions)}>
          <span className="pt-box" aria-hidden="true">{state.settings.collisions ? '✓' : ''}</span>
          Balls bump into each other
        </button>
      ) : (
        <p className="pt-note" style={{ marginTop: 0 }}>{state.settings.collisions ? 'Balls bump into each other.' : 'Balls pass through each other.'}</p>
      )}
      <div className="pt-row" style={{ marginTop: 16 }}>
        {isHost ? (
          <button type="button" className="pt-btn is-main pt-grow" disabled={chosen.length === 0} onClick={party.controls.start}>
            Start party
          </button>
        ) : (
          <span className="pt-grow pt-note" style={{ margin: 0 }}>Roll around while the host gets ready.</span>
        )}
        <button type="button" className="pt-btn" onClick={party.controls.leave}>Leave</button>
      </div>
    </div>
  )
}

function Standings({ party, snap }) {
  const { state, pid } = snap
  const rows = state.entrants.filter((id) => state.players[id]).map((id) => ({
    id,
    player: state.players[id],
    time: state.finishes[id],
    progress: party.progressOf(id),
  }))
  rows.sort((a, b) => {
    const fa = Number.isFinite(a.time)
    const fb = Number.isFinite(b.time)
    if (fa && fb) return a.time - b.time
    if (fa !== fb) return fa ? -1 : 1
    return b.progress - a.progress
  })
  return (
    <div className="pt-standings" aria-label="Standings">
      {rows.map((row, i) => (
        <div key={row.id} className={row.id === pid ? 'is-you' : ''} style={{ opacity: row.player.here ? 1 : 0.5 }}>
          <span className="pt-place">{i + 1}</span>
          <Dot color={row.player.color} />
          <span>{row.player.name}</span>
          <span>{Number.isFinite(row.time) ? formatTime(row.time) : `${Math.round(row.progress)} m`}</span>
        </div>
      ))}
    </div>
  )
}

function Racing({ party, snap }) {
  const { state, pid, isHost } = snap
  useClock(true)
  const goIn = state.go_at == null ? null : state.go_at - party.now()
  const total = state.settings.levels.length
  const title = `Level ${state.round + 1} of ${total} · ${levelTitle(state.level)}`
  const closesIn = state.close_at != null && Object.keys(state.finishes).length > 0 ? Math.max(0, state.close_at - party.now()) : null
  const entrant = state.entrants.includes(pid)
  let banner = title
  if (state.phase === 'loading') {
    const ready = state.loaded.length
    banner = `${title} — loading (${ready}/${state.entrants.length} ready)`
  } else if (!entrant) {
    banner = 'You joined mid-level — you race from the next one'
  } else if (Number.isFinite(state.finishes[pid])) {
    banner = `Finished in ${formatTime(state.finishes[pid])}${closesIn != null ? ` · level closes in ${Math.ceil(closesIn)} s` : ''}`
  } else if (closesIn != null) {
    banner = `Someone finished! Level closes in ${Math.ceil(closesIn)} s`
  }
  return (
    <>
      <div className="pt-banner" role="status">{banner}</div>
      {state.phase === 'racing' && goIn != null && goIn > -0.8 && entrant && (
        <div key={goIn > 0 ? Math.ceil(goIn) : 'go'} className={`pt-count${goIn <= 0 ? ' is-go' : ''}`} aria-live="assertive">
          {goIn > 0 ? Math.ceil(goIn) : 'GO!'}
        </div>
      )}
      {state.phase === 'racing' && <Standings party={party} snap={snap} />}
      {isHost && state.phase === 'racing' && (
        <div className="pt-panel" style={{ top: 'auto', bottom: 14, width: 'auto', padding: 8 }}>
          <button type="button" className="pt-btn" onClick={party.controls.endRoundNow}>End level now</button>
        </div>
      )}
    </>
  )
}

function Results({ party, snap }) {
  const { state, pid, isHost } = snap
  const round = state.history[state.history.length - 1]
  const last = state.round + 1 >= state.settings.levels.length
  const nextTitle = last ? 'Final results' : `Next: ${levelTitle(state.settings.levels[state.round + 1])}`
  return (
    <div className="pt-scrim" style={{ background: 'rgba(5,8,14,0.35)' }}>
      <div className="pt-card is-wide" role="dialog" aria-labelledby="pt-results-title">
        <h2 id="pt-results-title">{levelTitle(round?.level)} results</h2>
        <p className="pt-sub">Level {state.round + 1} of {state.settings.levels.length}</p>
        <table className="pt-table">
          <thead>
            <tr><th>#</th><th>Player</th><th className="is-num">Time</th><th className="is-num">Points</th><th className="is-num">Total</th></tr>
          </thead>
          <tbody>
            {(round?.results || []).map((row, i) => {
              const player = state.players[row.pid] || { name: '?', color: '#888' }
              return (
                <tr key={row.pid} className={row.pid === pid ? 'is-you' : ''}>
                  <td>{row.time != null ? i + 1 : '–'}</td>
                  <td><span className="pt-row" style={{ gap: 8 }}><Dot color={player.color} />{player.name}</span></td>
                  <td className="is-num">{row.time != null ? formatTime(row.time) : 'DNF'}</td>
                  <td className="is-num pt-gain">+{row.points}</td>
                  <td className="is-num">{state.totals[row.pid] || 0}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="pt-row" style={{ marginTop: 18 }}>
          {isHost ? (
            <button type="button" className="pt-btn is-main pt-grow" onClick={party.controls.next}>{nextTitle}</button>
          ) : (
            <span className="pt-grow pt-note" style={{ margin: 0 }}>Waiting for the host…</span>
          )}
          <button type="button" className="pt-btn" onClick={party.controls.leave}>Leave</button>
        </div>
      </div>
    </div>
  )
}

const PODIUM = [
  { place: 2, height: 78, color: '#c9d3df' },
  { place: 1, height: 118, color: '#ffd166' },
  { place: 3, height: 56, color: '#e0a36b' },
]

function Podium({ party, snap }) {
  const { state, pid, isHost } = snap
  const rows = standings(state)
  const at = (place) => rows[place - 1]
  return (
    <div className="pt-scrim">
      <div className="pt-card is-wide" role="dialog" aria-labelledby="pt-podium-title">
        <h2 id="pt-podium-title">The podium</h2>
        <p className="pt-sub">{state.settings.levels.map(levelTitle).join(' · ')}</p>
        <div className="pt-podium">
          {PODIUM.map((step) => {
            const row = at(step.place)
            const player = row ? state.players[row.pid] : null
            return (
              <div key={step.place} className="pt-step">
                {step.place === 1 && player && <span className="pt-crown" aria-hidden="true">👑</span>}
                {player ? <span className="pt-ball" style={{ background: player.color }} aria-hidden="true" /> : null}
                <span className="pt-name">{player ? player.name : '—'}</span>
                <span className="pt-pts">{row ? `${row.points} pts` : ''}</span>
                <div className="pt-block" style={{ height: step.height, background: step.color }}>{step.place}</div>
              </div>
            )
          })}
        </div>
        {rows.length > 3 && (
          <table className="pt-table">
            <tbody>
              {rows.slice(3).map((row, i) => (
                <tr key={row.pid} className={row.pid === pid ? 'is-you' : ''}>
                  <td>{i + 4}</td>
                  <td><span className="pt-row" style={{ gap: 8 }}><Dot color={state.players[row.pid]?.color} />{state.players[row.pid]?.name}</span></td>
                  <td className="is-num">{row.points} pts</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="pt-row" style={{ marginTop: 18 }}>
          {isHost && <button type="button" className="pt-btn is-main pt-grow" onClick={party.controls.again}>Back to the lobby</button>}
          <button type="button" className={`pt-btn${isHost ? '' : ' pt-grow'}`} onClick={party.controls.leave}>{isHost ? 'End party' : 'Leave'}</button>
        </div>
      </div>
    </div>
  )
}

export function PartyOverlay({ party }) {
  const snap = useParty(party)
  const [menu, setMenu] = useState(false)
  const inParty = !!snap?.state
  useEffect(() => {
    if (inParty) setMenu(false)
  }, [inParty])
  if (!party || !snap) return null
  const { state, isHost, roomStatus } = snap
  const hostMissing = inParty && !isHost && state.players[state.host] && !state.players[state.host].here
  return (
    <div className="pt-layer">
      <style>{PARTY_CSS}</style>
      {!inParty && !menu && (
        <button type="button" className="pt-chip" onClick={() => setMenu(true)}>
          <span aria-hidden="true">🎉</span> Party
        </button>
      )}
      {!inParty && menu && <StartCard party={party} snap={snap} onClose={() => { party.controls.leave(); setMenu(false) }} />}
      {inParty && state.phase === 'lobby' && <Lobby party={party} snap={snap} />}
      {inParty && (state.phase === 'loading' || state.phase === 'racing') && <Racing party={party} snap={snap} />}
      {inParty && state.phase === 'results' && <Results party={party} snap={snap} />}
      {inParty && state.phase === 'podium' && <Podium party={party} snap={snap} />}
      {inParty && (roomStatus === 'connecting' || hostMissing) && (
        <div className="pt-banner" style={{ marginTop: 116 }} role="status">
          {roomStatus === 'connecting' ? 'Reconnecting to the party…' : 'The host has left — waiting for them to come back'}
        </div>
      )}
    </div>
  )
}
