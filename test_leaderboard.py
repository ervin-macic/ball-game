"""Checks for the community leaderboard: python3 test_leaderboard.py

fixtures/autopilot_lap.json is a real lap recorded by the game's own test
autopilot (BALL_GAME_DUMP_GHOST=... with ball-game/tests/run_tests.gd).
"""
import copy
import json
import tempfile
import unittest
from pathlib import Path

import leaderboard as L

LAP = json.loads(Path(__file__).with_name('fixtures').joinpath('autopilot_lap.json').read_text())
TIME = LAP['time']


def variant(**changes):
    ghost = copy.deepcopy(LAP)
    ghost.update(changes)
    return ghost


def positions(ghost):
    p = ghost['p']
    return [p[i:i + 3] for i in range(0, len(p), 3)]


def flatten(points):
    return [v for point in points for v in point]


# Each level's current leaderboard track (LevelCatalog records ids).
TRACKS = {'beach': 'beach_8', 'jungle': 'jungle_8', 'winter': 'winter_9'}

class RunChecks(unittest.TestCase):
    def rejects(self, seconds, ghost, words):
        with self.assertRaises(L.Problem) as caught:
            L.check_run('test_track', seconds, ghost)
        self.assertIn(words, caught.exception.message)

    def test_a_real_lap_is_accepted(self):
        L.check_run('test_track', TIME, LAP)

    def test_a_typed_in_time_is_rejected(self):
        self.rejects(TIME - 3, LAP, "doesn't match")

    def test_a_missing_recording_is_rejected(self):
        self.rejects(TIME, None, 'missing')

    def test_a_recording_cut_short_is_rejected(self):
        short = variant(p=LAP['p'][: len(LAP['p']) // 2])
        self.rejects(TIME, short, "doesn't cover")

    def test_a_sped_up_recording_is_rejected(self):
        # The same path squeezed into fewer samples covers the whole run's time
        # only if the sample count matches, so this is caught as a short recording.
        fast = variant(time=TIME * 0.7)
        self.rejects(TIME * 0.7, fast, "doesn't cover")

    def test_a_shortcut_is_rejected(self):
        points = positions(LAP)
        start, end = points[0], points[-1]
        # Fly straight from the start to the finish in the same number of samples.
        n = len(points)
        straight = [[round(start[k] + (end[k] - start[k]) * i / (n - 1)) for k in range(3)] for i in range(n)]
        self.rejects(TIME, variant(p=flatten(straight)), 'left the track')

    def test_teleporting_is_rejected(self):
        points = positions(LAP)
        points[100] = [points[100][0] + 50_000, points[100][1], points[100][2]]
        self.rejects(TIME, variant(p=flatten(points)), 'faster than it can')

    def test_a_run_that_does_not_start_on_the_line_is_rejected(self):
        points = positions(LAP)[30:]
        self.rejects(len(points) / 30, variant(p=flatten(points), time=len(points) / 30), 'start line')

    def test_unknown_tracks_are_rejected(self):
        with self.assertRaises(L.Problem):
            L.track_id('../secrets')
        with self.assertRaises(L.Problem):
            L.track_id('no_such_track')


class ThemedLevels(unittest.TestCase):
    """Each level's own leaderboard accepts a real lap of that level only."""

    def lap(self, level):
        return json.loads(Path(__file__).with_name('fixtures').joinpath(f'autopilot_{level}.json').read_text())

    def test_each_level_accepts_its_own_lap(self):
        for level in ('beach', 'jungle', 'winter'):
            with self.subTest(level=level):
                ghost = self.lap(level)
                L.check_run(TRACKS[level], ghost['time'], ghost)

    def test_each_level_accepts_a_lap_along_its_alternative_route(self):
        for level in ('beach', 'jungle', 'winter'):
            with self.subTest(level=level):
                ghost = json.loads(Path(__file__).with_name('fixtures').joinpath(f'autopilot_{level}_routes.json').read_text())
                L.check_run(TRACKS[level], ghost['time'], ghost)

    def test_a_route_lap_needs_the_route_in_the_outline(self):
        ghost = json.loads(Path(__file__).with_name('fixtures').joinpath('autopilot_winter_routes.json').read_text())
        shape = dict(L.outline(TRACKS['winter']), branches=[])
        L._outlines['winter_no_routes'] = shape
        try:
            with self.assertRaises(L.Problem):
                L.check_run('winter_no_routes', ghost['time'], ghost)
        finally:
            L._outlines.pop('winter_no_routes')

    def test_a_lap_of_another_level_is_rejected(self):
        ghost = self.lap('jungle')
        with self.assertRaises(L.Problem):
            L.check_run('winter_9', ghost['time'], ghost)


class Board(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.db = L.connect(Path(self.dir.name) / 'board.sqlite3')
        self.now = 1_000_000.0

    def tearDown(self):
        self.db.close()
        self.dir.cleanup()

    def submit(self, player, request_id, seconds=TIME):
        self.now += 60
        ghost = variant(time=seconds) if seconds != TIME else LAP
        return L.record_run(self.db, 'test_track', player, seconds, ghost, 'example.org', request_id, now=self.now)

    def test_players_are_ranked_by_their_best_run(self):
        self.submit('ana', 'a' * 16)
        self.submit('ben', 'b' * 16, TIME - 0.02)
        result = self.submit('ana', 'c' * 16, TIME + 0.03)
        self.assertEqual((result['rank'], result['runs'], result['personal_best']), (2, 2, False))
        board = L.board(self.db, 'test_track', 'ana')
        self.assertEqual([row['player'] for row in board['top']], ['ben', 'ana'])
        self.assertEqual((board['runs'], board['players'], board['you']['rank']), (3, 2, 2))

    def test_a_repeated_request_is_recorded_once(self):
        first = self.submit('ana', 'a' * 16)
        again = self.submit('ana', 'a' * 16)
        self.assertEqual(first, again)
        self.assertEqual(L.board(self.db, 'test_track')['runs'], 1)

    def test_runs_faster_than_they_can_be_driven_are_refused(self):
        self.submit('ana', 'a' * 16)
        self.now -= 59  # one second later
        with self.assertRaises(L.Problem) as caught:
            L.record_run(self.db, 'test_track', 'ana', TIME, LAP, 'example.org', 'b' * 16, now=self.now + 1)
        self.assertEqual(caught.exception.status, 429)

    def test_the_best_ghost_is_kept_per_player(self):
        self.submit('ana', 'a' * 16, TIME + 0.04)
        self.submit('ana', 'b' * 16, TIME)
        self.submit('ana', 'c' * 16, TIME + 0.02)
        row = self.db.execute('SELECT time FROM best_ghosts WHERE player=?', ('ana',)).fetchone()
        self.assertAlmostEqual(row['time'], TIME)

    def test_a_rejected_run_leaves_no_trace(self):
        with self.assertRaises(L.Problem):
            L.record_run(self.db, 'test_track', 'ana', TIME - 3, LAP, 'example.org', 'a' * 16, now=self.now)
        self.assertEqual(L.board(self.db, 'test_track')['runs'], 0)


if __name__ == '__main__':
    unittest.main(verbosity=1)
