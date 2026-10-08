"""The cross-installation path of the community leaderboard: python3 test_service.py

Another player's installation posts a run to the hub's `exchange`; the hub
checks in the identity directory that the sender belongs to the player and
fetches the proof back from the sender before recording it. The directory and
the network are stood in for; the leaderboard, the run checks and the proof
logic are the real ones.
"""
import asyncio
import json
import os
import secrets
import tempfile
import time
import unittest
from pathlib import Path

STORE = tempfile.mkdtemp()
os.environ['APP_STORAGE_DIR'] = STORE
os.environ['INSTANCE_ORIGIN'] = 'https://mobius-production-8969.up.railway.app'

import service as S  # noqa: E402

LAP = json.loads(Path(__file__).with_name('fixtures').joinpath('autopilot_lap.json').read_text())
SENDER = 'friend.example.org'


class Exchange(unittest.TestCase):
    def setUp(self):
        self.proofs = {}
        self.hosts = {'maja': [SENDER]}

        async def hosts_of(player):
            return self.hosts.get(player, [])

        async def peer(host, path, body=None, query=None):
            assert host == SENDER and path.startswith('proof/')
            return self.proofs[path[len('proof/'):]]

        S.hosts_of, S.peer = hosts_of, peer

    def post(self, player='maja', forge=False, time_s=None):
        command = {'action': 'submit', 'actor': player, 'request_id': secrets.token_hex(8),
                   'body': {'track': 'test_track', 'time': time_s or LAP['time'], 'ghost': LAP}}
        key = secrets.token_hex(32)
        signed = dict(command, request_id='other') if forge else command
        self.proofs[key] = {'digest': S.digest(signed), 'actor': player, 'target': S.HOST,
                            'expires': time.time() + 60}
        request = {'schema': 1, 'public': True, 'path': 'exchange', 'method': 'POST',
                   'body': {'sender': SENDER, 'proof': key, 'request': command}}
        return asyncio.run(S.public_request(request))

    def board(self):
        request = {'schema': 1, 'public': True, 'path': 'board', 'method': 'GET', 'query': {'track': ['test_track']}}
        return asyncio.run(S.public_request(request))

    def test_another_installations_run_reaches_the_board(self):
        result = self.post()
        self.assertEqual(result.get('rank'), 1)
        top = self.board()['top']
        self.assertTrue(any(row['player'] == 'maja' for row in top))

    def test_a_forged_proof_is_refused(self):
        with self.assertRaises(S.Problem):
            self.post(forge=True)

    def test_an_installation_not_linked_to_the_player_is_refused(self):
        self.hosts['maja'] = ['someone-else.example.org']
        with self.assertRaises(S.Problem):
            self.post()


if __name__ == '__main__':
    unittest.main()
