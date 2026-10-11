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

    def test_a_lap_of_another_level_is_rejected(self):
        ghost = self.lap('jungle')
        with self.assertRaises(L.Problem):
            L.check_run('winter_9', ghost['time'], ghost)


class OffTrackRules(unittest.TestCase):
    """The game's own rules on a straight test track: short trips off the track
    are fine (the game sends the ball back after about 4 s), long ones aren't;
    a run has to end going through the finish gate, between the posts and under
    the banner."""

    def setUp(self):
        L._outlines['straight'] = {
            'spawn': [0.0, 0.55, 0.0], 'max_speed': 120.0, 'off_road': 32.0, 'off_road_drop': 4.0,
            'finish': {'origin': [1100.0, 0.0, 0.0], 'forward': [1.0, 0.0, 0.0], 'right': [0.0, 0.0, 1.0],
                       'up': [0.0, 1.0, 0.0], 'gate_width': 11.4, 'opening': [-0.5, 5.9]},
            'centreline': [[float(x), 0.0, 0.0, float(x)] for x in range(0, 1201, 2)],
            'branches': [[[float(x), 0.0, 100.0, float(x)] for x in range(200, 601, 2)]],
        }

    def tearDown(self):
        L._outlines.pop('straight')

    @staticmethod
    def run_along(offset=lambda x: (0.0, 0.0), samples=1100):
        """A run at 30 m/s along the straight, sideways/up by offset(x) (metres),
        its last sample just before the finish line."""
        points = [[x, 0.55 + offset(x)[1], offset(x)[0]] for x in (i * 1.0 for i in range(samples))]
        return {'v': 1, 'hz': 30, 'time': len(points) / 30,
                'p': [round(v * 1000) for point in points for v in point]}

    @staticmethod
    def ending(side, up):
        """Easing over the last 40 m to finish `side` beside and `up` above the road's middle."""
        return lambda x: (side * min(1.0, max(0.0, (x - 1059) / 40)), up * min(1.0, max(0.0, (x - 1059) / 40)))

    @staticmethod
    def trip(start, seconds, distance):
        """Out to `distance` beside the track at 3 m per sample, stay for `seconds`, back."""
        ramp = distance / 3.0
        def offset(x):
            t = x - start
            if t < 0:
                return 0.0
            return max(0.0, min(distance, t * 3.0, (2 * ramp + seconds * 30 - t) * 3.0))
        return offset

    def check(self, ghost, track='straight'):
        L.check_run(track, ghost['time'], ghost)

    def test_a_short_trip_off_the_track_is_accepted(self):
        self.check(self.run_along(lambda x: (self.trip(700, 2.0, 80.0)(x), 0.0)))

    def test_a_long_trip_off_the_track_is_rejected(self):
        with self.assertRaises(L.Problem) as caught:
            self.check(self.run_along(lambda x: (self.trip(700, 7.0, 80.0)(x), 0.0)))
        self.assertIn('left the track for too long', caught.exception.message)

    def test_flying_high_above_the_track_is_not_leaving_it(self):
        self.check(self.run_along(lambda x: (0.0, self.trip(700, 8.0, 90.0)(x))))

    def test_rolling_far_below_the_track_is_leaving_it(self):
        with self.assertRaises(L.Problem):
            self.check(self.run_along(lambda x: (0.0, -self.trip(700, 7.0, 30.0)(x))))

    def test_an_alternative_route_counts_as_track(self):
        on_route = self.run_along(lambda x: (self.trip(170, 12.0, 100.0)(x), 0.0))
        self.check(on_route)
        L._outlines['straight']['branches'] = []
        with self.assertRaises(L.Problem):
            self.check(on_route)

    def test_a_finish_goes_through_the_gate(self):
        self.check(self.run_along())  # rolling through the middle
        self.check(self.run_along(self.ending(-5.0, 0.0)))  # right up by a post
        self.check(self.run_along(self.ending(1.0, 4.5)))  # jumping through under the banner

    def test_passing_beside_over_or_under_the_gate_is_rejected(self):
        for side, up, where in ((10.0, 0.0, 'beside a post'), (0.0, 12.0, 'over the banner'),
                                (0.0, -9.5, 'under the road, having missed a leap'), (18.0, 0.0, 'far beside')):
            with self.subTest(where=where):
                with self.assertRaises(L.Problem) as caught:
                    self.check(self.run_along(self.ending(side, up)))
                self.assertIn("doesn't end at the finish", caught.exception.message)

    def test_ending_short_of_the_line_is_rejected(self):
        with self.assertRaises(L.Problem) as caught:
            self.check(self.run_along(samples=1080))
        self.assertIn("doesn't end at the finish", caught.exception.message)


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
