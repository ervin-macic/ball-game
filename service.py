#!/usr/bin/env python3
"""Ball Game service: the community leaderboard.

One Möbius installation, the hub, keeps the shared board (see leaderboard.py).
Every other installation's game talks to its own service here, which forwards:

- reading the board is a public GET on the hub;
- posting a run proves who sent it, the way Möbius apps federate: the sender
  stores a short-lived proof bound to the exact request and posts the request
  to the hub's `exchange`. The hub checks, through the Möbius identity
  directory, that the sending installation belongs to the player's @handle,
  then fetches the proof back from that installation. No credential leaves an
  installation, and nobody can post under someone else's handle.
"""
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import os
import re
import secrets
import socket
import sys
import time
from pathlib import Path
from urllib.parse import quote, urlsplit

import httpx

from leaderboard import Problem, board, connect, handle, record_run, require, track_id, check_run

HUB_HOST = 'mobius-production-8969.up.railway.app'
SERVICE_PATH = '/api/app-services/ball-game'
STORE = Path(os.environ['APP_STORAGE_DIR'])
DB_PATH = STORE / 'community' / 'leaderboard.sqlite3'
HOST = urlsplit(os.environ.get('INSTANCE_ORIGIN', '')).netloc.lower()
IS_HUB = HOST == HUB_HOST
PROOF_SECONDS = 120
MAX_PEER_RESPONSE = 256 * 1024


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def database():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    return connect(DB_PATH)


def first(query: dict, name: str):
    values = query.get(name) if isinstance(query, dict) else None
    return values[0] if isinstance(values, list) and values else None


# --- Talking to Möbius and to other installations ------------------------------

async def platform(method: str, path: str):
    async with httpx.AsyncClient(timeout=6, follow_redirects=False, trust_env=False) as client:
        response = await client.request(method, os.environ['API_BASE_URL'].rstrip('/') + path,
                                        headers={'Authorization': 'Bearer ' + os.environ['APP_TOKEN']})
    if response.status_code >= 400:
        raise Problem(502, 'Möbius could not complete the request. Please retry.')
    return response.json() if response.content else {}


async def player_handle() -> str:
    identity = await platform('GET', '/api/identity')
    profile = identity.get('profile') or {}
    require(not identity.get('account_unavailable') and profile.get('handle'),
            'Connect a Möbius account with an @handle (Möbius · You) to join the community leaderboard.', 409)
    return handle(profile['handle'])


async def hosts_of(player: str) -> list[str]:
    found = await platform('GET', '/api/identity/handles/' + quote(player, safe=''))
    require(found.get('linked') is True and found.get('hosts'), 'That Möbius ID has no reachable installation.', 403)
    return [h.lower() for h in found['hosts'] if isinstance(h, str)]


def public_host(name: str) -> str:
    """A public internet host name: resolves only to public addresses."""
    require(isinstance(name, str) and re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?', name) and '.' in name,
            'Invalid installation address.', 403)
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(name, 443, type=socket.SOCK_STREAM)}
    except OSError:
        raise Problem(502, 'The other Möbius installation could not be reached.')
    require(addresses and all(ipaddress.ip_address(a.split('%')[0]).is_global for a in addresses),
            'Invalid installation address.', 403)
    return name


async def peer(host: str, path: str, body=None, query: dict | None = None):
    url = 'https://' + public_host(host) + SERVICE_PATH + '/' + path
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False, trust_env=False) as client:
            async with client.stream('POST' if body is not None else 'GET', url, json=body, params=query) as response:
                raw = b''
                async for chunk in response.aiter_bytes():
                    raw += chunk
                    if len(raw) > MAX_PEER_RESPONSE:
                        raise Problem(502, 'The other Möbius installation sent too much data.')
        data = json.loads(raw) if raw else {}
    except Problem:
        raise
    except Exception:
        raise Problem(502, 'The community leaderboard is unreachable right now. This run stays on your own leaderboard.')
    if response.status_code >= 400:
        raise Problem(response.status_code if response.status_code < 500 else 502,
                      (data.get('error') if isinstance(data, dict) else None) or 'The community leaderboard refused the request.')
    return data


# --- Requests from this installation's game ------------------------------------------

async def own_request(req: dict):
    path, method = req.get('path'), req.get('method')
    body = req.get('body') if isinstance(req.get('body'), dict) else {}
    if path == 'board' and method == 'GET':
        track = track_id(first(req.get('query'), 'track'))
        try:
            player = await player_handle()
        except Problem:
            player = None
        if IS_HUB:
            with database() as db:
                result = board(db, track, player)
        else:
            result = await peer(HUB_HOST, 'board', query={'track': track, **({'player': player} if player else {})})
        return {**result, 'player': player, 'hub': HUB_HOST}
    if path == 'submit' and method == 'POST':
        track = track_id(body.get('track'))
        seconds, ghost, request_id = body.get('time'), body.get('ghost'), body.get('request_id')
        check_run(track, seconds, ghost)  # fail fast here rather than at the hub
        player = await player_handle()
        run = {'track': track, 'time': seconds, 'ghost': ghost}
        if IS_HUB:
            with database() as db:
                return {**record_run(db, track, player, seconds, ghost, HOST, request_id), 'player': player}
        require(HOST in await hosts_of(player),
                "This installation's address isn't registered to your Möbius ID yet.", 409)
        command = {'action': 'submit', 'body': run, 'actor': player, 'request_id': request_id}
        key = secrets.token_hex(32)
        expires = time.time() + PROOF_SECONDS
        proof = {'digest': digest(command), 'actor': player, 'target': HUB_HOST, 'expires': expires}
        with database() as db:
            db.execute('DELETE FROM proofs WHERE expires < ?', (time.time(),))
            db.execute('INSERT INTO proofs VALUES (?,?,?)', (key, json.dumps(proof), expires))
        result = await peer(HUB_HOST, 'exchange', {'sender': HOST, 'proof': key, 'request': command})
        return {**result, 'player': player}
    raise Problem(404, 'Not found.')


# --- Requests from anyone (other installations) ---------------------------------------

async def public_request(req: dict):
    path, method = req.get('path') or '', req.get('method')
    body = req.get('body')
    if path.startswith('proof/') and method == 'GET':
        key = path[len('proof/'):]
        require(re.fullmatch(r'[a-f0-9]{64}', key), 'Proof not found.', 404)
        with database() as db:
            row = db.execute('SELECT document, expires FROM proofs WHERE id=?', (key,)).fetchone()
        require(row is not None and row['expires'] > time.time(), 'Proof expired.', 403)
        return json.loads(row['document'])
    require(IS_HUB, 'This installation does not host the Ball Game leaderboard.', 404)
    if path == 'board' and method == 'GET':
        query = req.get('query')
        player = first(query, 'player')
        with database() as db:
            return board(db, track_id(first(query, 'track')), handle(player) if player else None)
    if path == 'exchange' and method == 'POST':
        require(isinstance(body, dict) and set(body) == {'sender', 'proof', 'request'}, 'Invalid request.')
        sender, key, command = body['sender'], body['proof'], body['request']
        require(isinstance(sender, str) and isinstance(key, str) and re.fullmatch(r'[a-f0-9]{64}', key), 'Invalid proof.')
        require(isinstance(command, dict) and set(command) == {'action', 'body', 'actor', 'request_id'}
                and command['action'] == 'submit' and isinstance(command['body'], dict), 'Invalid request.')
        player = handle(command['actor'])
        sender = sender.lower()
        require(sender in await hosts_of(player), 'That installation does not belong to this Möbius ID.', 403)
        run = command['body']
        track = track_id(run.get('track'))
        check_run(track, run.get('time'), run.get('ghost'))  # before calling anyone back
        proof = await peer(sender, 'proof/' + key)
        require(isinstance(proof, dict) and proof.get('digest') == digest(command) and proof.get('target') == HOST
                and proof.get('actor') == player and isinstance(proof.get('expires'), (int, float))
                and time.time() < proof['expires'] <= time.time() + PROOF_SECONDS + 5,
                "The identity proof doesn't match this run.", 403)
        with database() as db:
            return record_run(db, track, player, run['time'], run['ghost'], sender, command['request_id'])
    raise Problem(404, 'Not found.')


async def main(req) -> dict:
    require(isinstance(req, dict) and req.get('schema') == 1, 'Invalid service request.')
    if req.get('public'):
        return await public_request(req)
    scope = (req.get('actor') or {}).get('scope')
    require(scope in ('owner', 'app', 'agent'), 'Open Ball Game from your signed-in Möbius.', 403)
    return await own_request(req)


if __name__ == '__main__':
    try:
        print(json.dumps({'status': 200, 'body': asyncio.run(main(json.load(sys.stdin)))}))
    except Problem as exc:
        print(json.dumps({'status': exc.status, 'body': {'error': exc.message}}))
    except Exception as exc:
        print(f'{type(exc).__name__}: {exc}', file=sys.stderr)
        print(json.dumps({'status': 500, 'body': {'error': 'The leaderboard could not complete this request. Please retry.'}}))
