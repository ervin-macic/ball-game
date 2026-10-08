#!/usr/bin/env python3
"""Export Ball Game for the web and package it as this Möbius app's static assets.

    python3 tools/build_web.py [--godot /path/to/godot] [--app-dir /data/apps/ball-game]
    python3 tools/build_web.py --sync-only    # host page or manifest changed, game didn't

Runs the Godot project's "Web" export preset (single-threaded, so no
cross-origin isolation headers are needed) and writes web/:

  index.js, index.pck, index.audio*.worklet.js   copied as exported
  index.wasm.gz   the ~40 MB engine, gzipped. Möbius caps one static asset at
                  16 MiB, so the app host unpacks it in the browser
                  (DecompressionStream) when the engine asks for index.wasm.
  config.json     the engine settings the exported index.html would have
                  embedded, plus which files are shipped compressed.

The exported index.html is not shipped: the app's index.jsx is the host page.

Themed levels ship as separate resource packs (web/level_<id>.pck), each
downloaded the first time that level is played: one pack per level keeps every
file under Möbius' per-file cap and start-up as quick as before. The main
"Web" preset excludes them; this script works out each level's files (its
folder plus every res:// asset its scenes, materials and scripts name, even
through string constants) and exports them with a generated pack preset.

This project is where the app is edited. Möbius applies apps from /data/apps/<slug>,
so the package is then copied to --app-dir: the host page, manifest, icon,
README, LICENSE, the files listed in mobius.json source_files, this script, the
Store listing media (static/store/), the Godot project's source (ball-game/,
without its editor cache) and web/. Apply that directory afterwards.
"""
import argparse
import gzip
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GODOT_PROJECT = ROOT / "ball-game"
OUT = ROOT / "web"
PRESET = "Web"
COPIED = ["index.js", "index.pck", "index.audio.worklet.js", "index.audio.position.worklet.js"]
COMPRESSED = {"index.wasm": "index.wasm.gz"}
# Levels shipped as their own packs (see scripts/levels/level_catalog.gd).
LEVEL_PACKS = ["beach", "jungle", "winter"]
PRESETS = GODOT_PROJECT / "export_presets.cfg"
LEVEL_PRESET_MARKER = "\n; --- Generated level pack presets (tools/build_web.py) ---\n"
ASSET_MAX = 16 * 1024 * 1024        # manifest_contract.STATIC_ASSET_MAX_BYTES
ASSETS_TOTAL_MAX = 64 * 1024 * 1024  # manifest_contract.STATIC_ASSETS_TOTAL_MAX
APP_PACKAGE = ["index.jsx", "party.jsx", "mobius.json", "icon.png", "README.md", "LICENSE", "tools/build_web.py"]
PACKAGED_TREES = ["static/store"]
GODOT_SOURCE_IGNORED = shutil.ignore_patterns(".godot", "build", "*.tmp", "__pycache__")
DEFAULT_APP_DIR = "/data/apps/ball-game"


def find_godot(explicit: str | None) -> str:
    candidate = explicit or os.environ.get("GODOT") or shutil.which("godot") or shutil.which("godot4")
    if not candidate:
        sys.exit("Godot not found: pass --godot /path/to/godot or set GODOT.")
    return candidate


def export(godot: str, target: Path) -> None:
    command = [godot, "--headless", "--path", str(GODOT_PROJECT), "--export-release", PRESET, str(target / "index.html")]
    result = subprocess.run(command, capture_output=True, text=True)
    produced = target / "index.wasm"
    if result.returncode != 0 or not produced.is_file():
        sys.stderr.write(result.stdout[-4000:] + result.stderr[-4000:])
        sys.exit(f"Godot export failed (exit {result.returncode}). Export templates for this Godot version must be installed.")


def level_files(level_id: str) -> list[str]:
    """Every project file a level pack needs, as res:// paths.

    Follows ext_resource paths in scenes and materials, and res:// strings in
    scripts, including CONST + "relative/path" and "%s" patterns (expanded as
    wildcards) so assets a script loads by name come along too.
    """
    seen: set[str] = set()
    queue = [f"res://levels/{level_id}/{p.name}" for p in (GODOT_PROJECT / "levels" / level_id).iterdir()
             if p.suffix in (".tscn", ".gd", ".tres")]
    while queue:
        path = queue.pop()
        if path in seen:
            continue
        local = GODOT_PROJECT / path.removeprefix("res://")
        if not local.is_file():
            continue
        seen.add(path)
        if local.suffix not in (".tscn", ".tres", ".gd", ".gdshader"):
            continue
        text = local.read_text(encoding="utf-8", errors="replace")
        consts = dict(re.findall(r'const\s+(\w+)\s*:?=\s*"(res://[^"]+)"', text))
        found = set(re.findall(r'"(res://[^"]+)"', text))
        for name, base in consts.items():
            found.update(base + rel for rel in re.findall(rf'\b{name}\s*\+\s*"([^"]+)"', text))
            # CONST + variable (e.g. SOUNDS + file): take the folder's files.
            if base.endswith("/") and re.search(rf'\b{name}\s*\+\s*[A-Za-z_]', text):
                folder = GODOT_PROJECT / base.removeprefix("res://")
                queue.extend(base + p.name for p in folder.glob("*") if p.is_file() and not p.name.startswith(".") and p.suffix not in (".import", ".json", ".txt"))
        for ref in found:
            if "%" in ref:
                pattern = re.sub(r"%[sd]", "*", ref.removeprefix("res://"))
                queue.extend("res://" + str(m.relative_to(GODOT_PROJECT)) for m in GODOT_PROJECT.glob(pattern))
            elif not ref.endswith("/"):
                queue.append(ref)
    # Shared game code is in the main pack already.
    return sorted(p for p in seen if p.startswith(("res://levels/", "res://Assets/")))


def write_level_presets() -> None:
    text = PRESETS.read_text(encoding="utf-8").split(LEVEL_PRESET_MARKER)[0].rstrip() + "\n"
    blocks = []
    for n, level_id in enumerate(LEVEL_PACKS, 1):
        files = ", ".join(f'"{f}"' for f in level_files(level_id))
        blocks.append(f"""
[preset.{n}]

name="Level {level_id}"
platform="Web"
runnable=false
dedicated_server=false
custom_features=""
export_filter="resources"
export_files=PackedStringArray({files})
include_filter=""
exclude_filter=""
export_path=""
encryption_include_filters=""
encryption_exclude_filters=""
encrypt_pck=false
encrypt_directory=false
script_export_mode=2

[preset.{n}.options]

custom_template/debug=""
custom_template/release=""
variant/extensions_support=false
variant/thread_support=false
vram_texture_compression/for_desktop=true
vram_texture_compression/for_mobile=false
html/export_icon=false
html/custom_html_shell=""
html/head_include=""
html/canvas_resize_policy=2
html/focus_canvas_on_start=true
html/experimental_virtual_keyboard=false
progressive_web_app/enabled=false
""")
    PRESETS.write_text(text + LEVEL_PRESET_MARKER + "".join(blocks), encoding="utf-8")


def export_level_packs(godot: str, target: Path) -> None:
    write_level_presets()
    for level_id in LEVEL_PACKS:
        out = target / f"level_{level_id}.pck"
        command = [godot, "--headless", "--path", str(GODOT_PROJECT), "--export-pack", f"Level {level_id}", str(out)]
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0 or not out.is_file():
            sys.stderr.write(result.stdout[-4000:] + result.stderr[-4000:])
            sys.exit(f"Exporting the {level_id} level pack failed (exit {result.returncode}).")


def engine_config(exported_html: Path) -> dict:
    match = re.search(r"const GODOT_CONFIG = (\{.*?\});", exported_html.read_text(encoding="utf-8"))
    if not match:
        sys.exit("Could not find GODOT_CONFIG in the exported index.html.")
    config = json.loads(match.group(1))
    # The host page supplies canvas, paths and persistence; keep only engine settings.
    config["ensureCrossOriginIsolationHeaders"] = False
    config["mainPack"] = f"{config['executable']}.pck"
    config["compressed"] = COMPRESSED
    return config


def package(export_dir: Path) -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    for name in COPIED + [f"level_{level_id}.pck" for level_id in LEVEL_PACKS]:
        shutil.copyfile(export_dir / name, OUT / name)
    for name, packed in COMPRESSED.items():
        with open(export_dir / name, "rb") as raw, open(OUT / packed, "wb") as out:
            # mtime=0 and no filename keep the bytes identical across rebuilds.
            with gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=out, mtime=0) as packed_file:
                shutil.copyfileobj(raw, packed_file)
    config = engine_config(export_dir / "index.html")
    # Download progress for level packs even when a proxy drops Content-Length.
    config["packSizes"] = {f"level_{level_id}.pck": (OUT / f"level_{level_id}.pck").stat().st_size for level_id in LEVEL_PACKS}
    (OUT / "config.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")


def check(files: list[tuple[str, int]]) -> None:
    for name, size in files:
        if size > ASSET_MAX:
            sys.exit(f"web/{name} is {size} bytes, over Möbius' {ASSET_MAX}-byte static asset cap.")
    total = sum(size for _, size in files)
    if total > ASSETS_TOTAL_MAX:
        sys.exit(f"web/ totals {total} bytes, over Möbius' {ASSETS_TOTAL_MAX}-byte static asset budget.")
    manifest = json.loads((ROOT / "mobius.json").read_text(encoding="utf-8"))
    declared = set((manifest.get("static_assets") or {}).values())
    shipped = {f"web/{name}" for name, _ in files}
    if shipped - declared or {path for path in declared if path.startswith("web/")} - shipped:
        sys.exit(f"mobius.json static_assets must list exactly: {sorted(shipped)}")


SOURCE_ARCHIVE = "ball-game-source.tar.gz"


def source_archive(target: Path) -> None:
    """The Godot project as one reproducible archive: a public app may hold at
    most 250 files, and the project alone has hundreds. Third-party CC0 art that
    tools/fetch_assets.py downloads again stays out (unpack, then run it)."""
    import tarfile
    sys.path.insert(0, str(GODOT_PROJECT / "tools"))
    import fetch_assets
    refetchable = {GODOT_PROJECT / "Assets" / p for p in fetch_assets.fetchable()}
    skipped_dirs = {".godot", "build", "__pycache__"}
    files = []
    for path in sorted(GODOT_PROJECT.rglob("*")):
        relative = path.relative_to(GODOT_PROJECT)
        if any(part in skipped_dirs for part in relative.parts) or path.is_dir():
            continue
        if path in refetchable or path.suffix == ".tmp":
            continue
        files.append(path)

    def clean(info: tarfile.TarInfo) -> tarfile.TarInfo:
        info.mtime = 0
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        return info

    with open(target, "wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=raw, mtime=0) as packed:
            with tarfile.open(fileobj=packed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                for path in files:
                    archive.add(path, arcname=str(Path("ball-game") / path.relative_to(GODOT_PROJECT)), recursive=False, filter=clean)


def sync_app(app_dir: Path) -> None:
    if app_dir.resolve() == ROOT:
        print("The package is being built in place; nothing to copy.")
        return
    app_dir.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((ROOT / "mobius.json").read_text())
    for name in APP_PACKAGE + manifest.get("source_files", []):
        (app_dir / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, app_dir / name)
    # Only the current track outlines are part of the package.
    wanted = set(manifest.get("source_files", []))
    for outline in (app_dir / "tracks").glob("*.json"):
        if f"tracks/{outline.name}" not in wanted:
            outline.unlink()
    for tree in PACKAGED_TREES:
        if (app_dir / tree).exists():
            shutil.rmtree(app_dir / tree)
        shutil.copytree(ROOT / tree, app_dir / tree)
    if (app_dir / GODOT_PROJECT.name).exists():
        shutil.rmtree(app_dir / GODOT_PROJECT.name)
    source_archive(app_dir / SOURCE_ARCHIVE)
    if (app_dir / "web").exists():
        shutil.rmtree(app_dir / "web")
    shutil.copytree(OUT, app_dir / "web")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--godot", help="Godot 4 editor binary (defaults to $GODOT or godot on PATH)")
    parser.add_argument("--app-dir", default=DEFAULT_APP_DIR, help="Möbius app source to copy the package into")
    parser.add_argument("--sync-only", action="store_true", help="skip the Godot export; re-check and copy the package")
    args = parser.parse_args()
    if not args.sync_only:
        godot = find_godot(args.godot)
        with tempfile.TemporaryDirectory(prefix="ball-game-web-") as tmp:
            export(godot, Path(tmp))
            export_level_packs(godot, Path(tmp))
            package(Path(tmp))
    files = sorted((path.name, path.stat().st_size) for path in OUT.iterdir())
    check(files)
    for name, size in files:
        print(f"  web/{name:34} {size / 1e6:7.2f} MB")
    sync_app(Path(args.app_dir))
    print(f"Packaged {len(files)} files ({sum(s for _, s in files) / 1e6:.1f} MB) into {args.app_dir}. Apply it to publish.")


if __name__ == "__main__":
    main()
