# Ball Game

Precision ball racing for [Möbius](https://github.com/mobius-os), built in
Godot 4 with Jolt Physics. Roll, carve, jump and loop against the clock, race a
ghost of your best run, and climb a leaderboard shared by every player.

![Racing the ghost](static/store/1-ghost-split.jpg)

This repository is the Möbius app: the host page (`index.jsx`, `party.jsx`),
the leaderboard service (`service.py`, `leaderboard.py`), the packaged web build
(`web/`), and the game's Godot source in `ball-game-source.tar.gz` (a public app
holds at most 250 files, so the project ships as one archive). To change the
game, unpack it, fetch the CC0 art it leaves out, and open `ball-game/` in
Godot 4.4+ (its own README covers controls, tuning, track editing and tests):

```
tar -xzf ball-game-source.tar.gz
python3 ball-game/tools/fetch_assets.py
```

`tools/build_web.py` rebuilds `web/` and the archive.

## How the web build is hosted

- `index.jsx` is the host page. The Godot engine runs directly in this app's
  frame, whose policy allows WebAssembly. Möbius's packaged-document lane
  (`/app-embeds/` documents) does not, so the exported `index.html` isn't used.
- `web/` holds the packaged export: the engine script, worklets and game pack as
  exported, plus the ~40 MB engine binary gzipped (`index.wasm.gz`, about 10 MB),
  because one static asset is capped at 16 MiB. The host unpacks it in the
  browser while it downloads.
- Saved game data (settings, best times, every finished run, the best run's
  ghost) goes to app storage as JSON documents. The host reads them all before
  the engine starts and exposes `window.ballGameStore` (`read_doc`, `write_doc`,
  `remove_doc`), which Godot calls through `JavaScriptBridge`; the app frame has
  no IndexedDB for `user://` files. Each finished run also signals
  `item_created`.
- Graphics programs: browsers on Windows compile each WebGL program in a third
  of a second or more, and Godot 4.7's web renderer compiles four variants of
  every material's shader up front that it never draws with (each render pass
  picks a variant that says how lightmaps are handled; those four don't). The
  host page gives exactly those a tiny stand-in (`skipUnusedShaderVariants`),
  about half of all compiles, and signals `error` (`shader_variant`) if a
  stand-in is ever drawn with. Re-check the rule when upgrading Godot.
- When a level is ready the game reports its loading time through
  `window.ballGameHost.level_ready`, and the page signals `level_ready`
  (download, build and graphics seconds, programs compiled and skipped,
  browser); `app_ready` carries the program counts at start-up too. The first
  two runs of each level in a session signal `run_perf` when they end (frame
  rate, long frames and where on the track they were, the slowest frames,
  drawing time, window size) through `window.ballGameHost.run_perf`; the page
  adds `engine_ms` (median/95th percentile/max) and `engine_long`, how long
  the engine worked on each frame, timed by wrapping `requestAnimationFrame`
  (`run_started` resets it), so frames lost to the graphics card show up.
  Signals carry flat values only (at most 20), so lists go as text.

## Levels and their downloads

The game has the Tutorial Level (the original grid course, id `test_track`)
plus three themed levels (beach, forest, winter; see `ball-game/README.md`).
The Tutorial Level is in the main game pack;
each themed level is its own resource pack (`web/level_<id>.pck`, 2–10 MB),
downloaded the first time that level is chosen. That keeps every file under the
16 MiB static-asset cap and start-up as quick as before. The host page fetches
a pack with progress and writes it into the engine's in-memory file system
(`window.ballGameAssets`: `fetch_pack`, `pack_state`), where the game mounts it.
`tools/build_web.py` works out each level's files and exports the packs.

## Rebuilding after changing the game

From the repository root:

```
python3 tools/build_web.py --godot /path/to/godot --app-dir <installed app source>
```

It needs Godot's web export templates. It exports, rewrites `web/`, and copies
the app package (see the script's docstring) into `--app-dir`, typically
`/data/apps/<slug>` on a Möbius installation; apply that directory afterwards.
Run from inside an installed app's own source, it rebuilds `web/` in place.

## Community leaderboard

Every finished run is sent, with its ghost recording, to one shared board.

- **Where it lives.** One installation, the *hub*, keeps the board in SQLite
  (`community/leaderboard.sqlite3` in its app storage). The hub is
  `mobius-production-8969.up.railway.app` (`HUB_HOST` in `service.py`).
  Every other installation's game talks only to its own `service.py`, which
  forwards to the hub's public service at `/api/app-services/ball-game/…`.
  If the hub is down, runs still count on each player's own board but aren't
  sent later.
- **Who's who.** Players appear by their Möbius @handle; nobody types a name.
  A forwarded run carries a short-lived proof bound to that exact request. The
  hub checks in the Möbius identity directory that the sending installation
  belongs to the handle, then fetches the proof back from it, the same
  handshake Möbius apps use to federate. No credential leaves an installation.
  Players need a Möbius account with an @handle to post.
- **One board per level.** Each level's runs go to its own board (`track`
  = the level id), checked against that level's outline in `tracks/<id>.json`.
- **Run checks** (`leaderboard.py`), by the game's own rules: the recording
  must start on the start line, end going through the finish gate (between
  the posts and under the banner, as the game counts a finish: its last
  position within one recorded step of the way through), match the time,
  never move faster than the ball can, and never be away from the track for
  more than 6 s at a time (the game sends the ball back to the start after
  about 4 s off the track, so every run the game counts as finished passes,
  short cuts included). Away means further beside
  every part of the track or its routes than the game allows, or too far
  below it; flying high above doesn't count. The outlines are
  `tracks/<level>.json`, exported from the game (with its off-track limits
  and the finish gate's opening) by
  `ball-game/tools/export_track_outline.gd -- ../tracks`; re-export after
  changing a track, the gate or those limits. Runs from one player can't arrive faster
  than they can be driven. This stops typed-in times, teleports and long
  shortcuts, but a determined cheater can still fabricate a whole plausible
  recording; no game that trusts its players' devices can rule that out.
  Other installations run the same check before forwarding a run, so their
  players get these rules once they have this version.
- **What's sent and what's public.** Each finished run sends the player's
  @handle, the time, and the run's recording (positions and rotations) to the
  hub. The board shows each player's best time and run count to anyone. The hub
  also keeps each player's best recording, not shown yet, for checking
  suspicious runs.
- **Tests:** `python3 test_service.py` (another installation's run reaching the hub through `exchange`, a forged proof and an unlinked installation refused) and `python3 test_leaderboard.py` (25 checks, including real
  autopilot laps of every level, doctored versions, a lap of one level
  refused on another's board, and the off-track rules on a straight test
  track: a short trip off it passes, a long one doesn't, flying high above it
  is fine, routes count as track, and a run must end through the finish gate,
  not beside a post, over the banner or under the road).

## Party mode

`party.jsx` adds a **Party** button over the game. One player hosts and gets a
four-letter code; the others choose *Party → Join* and type it. The host picks
the levels (in order) and whether balls bump into each other, then starts.

- **Each level:** everyone loads it, a 3-2-1 countdown starts them at the same
  moment (on the server's clock), live standings show who's ahead, and the
  level closes 30 s after the first finish (or when everyone is done; the host
  can also end it). Points: 10, 8, 6, 5, 4, 3, 2, 1, then 1 for any other
  finish, 0 for none. After the last level the podium shows the top three
  (ties go to more wins, then the lower total time).
- **How it talks:** players meet in a Möbius live room (`window.mobius.live`,
  named `party-<code>`). The host's page is the referee: it keeps the party's
  state and broadcasts a snapshot whenever it changes (and every 3 s), and the
  others adopt it. Every player broadcasts its ball's position 15 times a
  second. Nothing is stored; a party lasts while the host's page is open. Up
  to 16 players.
- **Who can join:** any session of this app on this installation. That's you
  on any of your devices; for friends to join, the app has to be published
  publicly on this installation (then they play from its public page without
  an account). Players on other installations can't join yet: a live room
  belongs to one installation's app.
- **The game's side** is `ball-game/scripts/party/party_client.gd`, reached
  through `window.ballGameParty` (`state`, `remotes`, `pose`, `loaded`,
  `finish`). Party runs never count as personal records or community runs.

## License

MIT; see [LICENSE](LICENSE).
