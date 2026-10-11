"""Community leaderboard: run checks, storage and ranking (no network here).

One Möbius installation (the hub) keeps the shared board in SQLite. Every run
arrives with its ghost recording, which is checked against the track outline
exported from the game (tracks/<track>.json) by the game's own rules: it must
start at the spawn, end going through the finish gate (between the posts and
under the banner, as the game counts a finish), move no faster than the ball
can, and never stay away from the track longer than the game allows (it sends
the ball back to the start after about 4 s off the track, so however a run
got to the gate, it only strayed briefly, and it counts). That stops
typed-in times, teleports and long shortcuts; it can't stop a player who
fabricates a whole plausible recording, which no client-trusting game can.
"""
from __future__ import annotations

import json
import math
import re
import sqlite3
import time as clock
from pathlib import Path

TRACKS_DIR = Path(__file__).with_name('tracks')
TRACK_ID = re.compile(r'^[a-z0-9_]{1,40}$')
HANDLE = re.compile(r'^[a-z0-9](?:[a-z0-9_.-]{0,38}[a-z0-9])?$')
BOARD_SIZE = 10

# Run checks. Distances are metres, speeds metres per second.
START_RADIUS = 3.0         # the first sample is the ball on the spawn point
OFF_ROAD = 32.0            # away from the track: further than this beside every part of it
OFF_ROAD_DROP = 4.0        # ...or this far below it (RaceManager.off_track_reach/drop; outlines carry their own)
SLACK = 4.0                # the outline is the road's centre, sampled every 2 m
OFF_TRACK_SECONDS = 6.0    # longest time away from the track (the game allows about 4 s)
SPEED_MARGIN = 1.1         # over the ball's hard speed cap
MIN_TIME, MAX_TIME = 5.0, 900.0
# A player can't finish runs faster than they can drive them: runs from one
# player must be at least this share of the run's own time apart.
SPACING = 0.8


class Problem(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def require(condition, message: str, status: int = 400):
    if not condition:
        raise Problem(status, message)


def track_id(value) -> str:
    require(isinstance(value, str) and TRACK_ID.match(value), 'Unknown track.')
    require((TRACKS_DIR / f'{value}.json').is_file(), 'Unknown track.', 404)
    return value


def handle(value) -> str:
    value = value[1:] if isinstance(value, str) and value.startswith('@') else value
    require(isinstance(value, str) and HANDLE.match(value or ''), 'Invalid Möbius handle.')
    return value.lower()


_outlines: dict[str, dict] = {}


def outline(track: str) -> dict:
    if track not in _outlines:
        _outlines[track] = json.loads((TRACKS_DIR / f'{track}.json').read_text())
    return _outlines[track]


def check_run(track: str, seconds, ghost) -> None:
    """Raises Problem unless the recording is a plausible lap finishing in `seconds`."""
    require(isinstance(seconds, (int, float)) and math.isfinite(seconds), 'Invalid time.')
    require(MIN_TIME <= seconds <= MAX_TIME, 'That time is outside what the track allows.')
    require(isinstance(ghost, dict) and ghost.get('v') == 1, 'The run recording is missing.')
    hz = ghost.get('hz')
    require(isinstance(hz, (int, float)) and hz == 30, 'Unsupported run recording.')
    duration = ghost.get('time')
    require(isinstance(duration, (int, float)) and abs(duration - seconds) <= 0.05,
            "The recording doesn't match the time.")
    flat = ghost.get('p')
    require(isinstance(flat, list) and len(flat) % 3 == 0 and all(type(v) is int for v in flat),
            'Invalid run recording.')
    count = len(flat) // 3
    require(abs(count - seconds * hz) <= 3, "The recording doesn't cover the whole run.")
    points = [(flat[i] / 1000, flat[i + 1] / 1000, flat[i + 2] / 1000) for i in range(0, len(flat), 3)]

    shape = outline(track)
    require(math.dist(points[0], shape['spawn']) <= START_RADIUS, "The run doesn't start on the start line.")
    step_limit = shape['max_speed'] * SPEED_MARGIN / hz
    require(_ends_at_finish(shape['finish'], points, step_limit), "The run doesn't end at the finish.")
    near_track = _track_nearness(shape)
    away, longest_away = 0, OFF_TRACK_SECONDS * hz
    for i, point in enumerate(points):
        if i:
            require(math.dist(point, points[i - 1]) <= step_limit, 'The ball moved faster than it can.')
        away = 0 if near_track(point) else away + 1
        require(away <= longest_away, 'The run left the track for too long.')


def _ends_at_finish(finish: dict, points: list, step_limit: float) -> bool:
    """Whether the run ends going through the finish gate, where the game counts
    a finish: between the posts, from the road up to the banner (the outline's
    opening). The last recorded position is at most one recorded step from where
    the ball went through, so it must be that close to the way through."""
    step = math.dist(points[-1], points[-2]) if len(points) > 1 else step_limit
    reach = min(2.0 * step, step_limit) + 1.0  # the ball may speed up a little within a step
    offset = [points[-1][k] - finish['origin'][k] for k in range(3)]
    along_axis = lambda axis: sum(offset[k] * axis[k] for k in range(3))
    side, height, along = abs(along_axis(finish['right'])), along_axis(finish['up']), along_axis(finish['forward'])
    bottom, top = finish['opening']
    beside = max(side - finish['gate_width'] / 2, 0.0)
    above_or_below = max(bottom - height, height - top, 0.0)
    return math.sqrt(beside ** 2 + above_or_below ** 2 + along ** 2) <= reach


def _track_nearness(shape: dict):
    """A test of whether a position is near the track, as the game judges it:
    within reach beside some part of the main track or a route, and not too far
    below it (above doesn't count: the ball can fly high off a jump or vent)."""
    reach = shape.get('off_road', OFF_ROAD) + SLACK
    drop = shape.get('off_road_drop', OFF_ROAD_DROP) + SLACK
    grid: dict[tuple[int, int], list] = {}
    for q in shape['centreline'] + [q for branch in shape.get('branches', []) for q in branch]:
        grid.setdefault((math.floor(q[0] / reach), math.floor(q[2] / reach)), []).append(q)

    def near(point) -> bool:
        x, y, z = point
        cx, cz = math.floor(x / reach), math.floor(z / reach)
        for cell in ((cx, cz), (cx - 1, cz), (cx + 1, cz), (cx, cz - 1), (cx, cz + 1),
                     (cx - 1, cz - 1), (cx + 1, cz - 1), (cx - 1, cz + 1), (cx + 1, cz + 1)):
            for q in grid.get(cell, ()):
                if q[1] - y <= drop and math.hypot(q[0] - x, q[2] - z) <= reach:
                    return True
        return False

    return near


def connect(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(path, timeout=10, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS runs (
            id INTEGER PRIMARY KEY, track TEXT NOT NULL, player TEXT NOT NULL,
            time REAL NOT NULL, at REAL NOT NULL, host TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS runs_by_player ON runs(track, player, time);
        CREATE TABLE IF NOT EXISTS best_ghosts (
            track TEXT NOT NULL, player TEXT NOT NULL, time REAL NOT NULL, ghost TEXT NOT NULL,
            PRIMARY KEY (track, player));
        CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, result TEXT NOT NULL, at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS proofs (id TEXT PRIMARY KEY, document TEXT NOT NULL, expires REAL NOT NULL);
    ''')
    return db


def record_run(db: sqlite3.Connection, track: str, player: str, seconds: float, ghost: dict,
               host: str, request_id: str, now: float | None = None) -> dict:
    """Checks and stores one finished run; returns the player's standing. Idempotent per request_id."""
    require(isinstance(request_id, str) and re.fullmatch(r'[A-Za-z0-9-]{16,64}', request_id),
            'A request identifier is required.')
    now = clock.time() if now is None else now
    receipt_id = f'{player}:{request_id}'
    db.execute('BEGIN IMMEDIATE')
    try:
        done = db.execute('SELECT result FROM receipts WHERE id=?', (receipt_id,)).fetchone()
        if done:
            db.execute('COMMIT')
            return json.loads(done['result'])
        check_run(track, seconds, ghost)
        last = db.execute('SELECT MAX(at) AS at FROM runs WHERE track=? AND player=?', (track, player)).fetchone()['at']
        require(last is None or now - last >= seconds * SPACING,
                'Runs are arriving faster than they can be driven.', 429)
        db.execute('INSERT INTO runs (track, player, time, at, host) VALUES (?,?,?,?,?)',
                   (track, player, seconds, now, host))
        best = db.execute('SELECT time FROM best_ghosts WHERE track=? AND player=?', (track, player)).fetchone()
        personal_best = best is None or seconds < best['time']
        if personal_best:
            db.execute('INSERT OR REPLACE INTO best_ghosts VALUES (?,?,?,?)',
                       (track, player, seconds, json.dumps(ghost, separators=(',', ':'))))
        result = {'accepted': True, 'personal_best': personal_best, **standing(db, track, player)}
        db.execute('DELETE FROM receipts WHERE at < ?', (now - 7 * 86400,))
        db.execute('INSERT INTO receipts VALUES (?,?,?)', (receipt_id, json.dumps(result), now))
        db.execute('COMMIT')
        return result
    except BaseException:
        db.execute('ROLLBACK')
        raise


def standing(db: sqlite3.Connection, track: str, player: str) -> dict:
    mine = db.execute('SELECT MIN(time) AS best, COUNT(*) AS runs FROM runs WHERE track=? AND player=?',
                      (track, player)).fetchone()
    players = db.execute('SELECT COUNT(DISTINCT player) AS n FROM runs WHERE track=?', (track,)).fetchone()['n']
    if not mine['runs']:
        return {'rank': None, 'best': None, 'runs': 0, 'players': players}
    ahead = db.execute('''SELECT COUNT(*) AS n FROM (SELECT MIN(time) AS best FROM runs
                          WHERE track=? GROUP BY player) WHERE best < ?''', (track, mine['best'])).fetchone()['n']
    return {'rank': ahead + 1, 'best': mine['best'], 'runs': mine['runs'], 'players': players}


def board(db: sqlite3.Connection, track: str, player: str | None = None) -> dict:
    """Fastest players (each player's best run), plus totals and the viewer's own standing."""
    rows = db.execute('''SELECT player, MIN(time) AS best, COUNT(*) AS runs, MAX(at) AS last
                         FROM runs WHERE track=? GROUP BY player ORDER BY best, MIN(at) LIMIT ?''',
                      (track, BOARD_SIZE)).fetchall()
    totals = db.execute('SELECT COUNT(*) AS runs, COUNT(DISTINCT player) AS players FROM runs WHERE track=?',
                        (track,)).fetchone()
    return {
        'track': track,
        'top': [{'rank': i + 1, 'player': r['player'], 'time': r['best'], 'runs': r['runs']}
                for i, r in enumerate(rows)],
        'runs': totals['runs'],
        'players': totals['players'],
        'you': standing(db, track, player) if player else None,
    }
