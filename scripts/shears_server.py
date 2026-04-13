#!/usr/bin/env python3
"""Shears web UI server — serves the review interface for checking LaTeX paper quality."""

import argparse
import json
import os
import socket
import threading
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file

# Globals set at startup
SESSION_DIR: Path = Path(".")
PDF_PATH: Path | None = None


# ---------------------------------------------------------------------------
# Caching layer for result files
# ---------------------------------------------------------------------------
_problem_cache: dict[str, dict] = {}  # filename -> parsed json
_problem_mtimes: dict[str, float] = {}  # filename -> mtime
_cache_lock = threading.Lock()


def _scan_problems() -> list[dict]:
    """Scan the check/ directory for problem JSON files, with mtime-based caching."""
    check_dir = SESSION_DIR / "check"
    if not check_dir.is_dir():
        return []

    current_files = {}
    for entry in os.scandir(check_dir):
        if entry.name.endswith(".json") and entry.is_file():
            current_files[entry.name] = entry.stat().st_mtime

    with _cache_lock:
        # Remove deleted files from cache
        for fname in list(_problem_cache.keys()):
            if fname not in current_files:
                del _problem_cache[fname]
                _problem_mtimes.pop(fname, None)

        # Add or update changed files
        for fname, mtime in current_files.items():
            if fname not in _problem_mtimes or _problem_mtimes[fname] < mtime:
                try:
                    data = json.loads((check_dir / fname).read_text())
                    _problem_cache[fname] = data
                    _problem_mtimes[fname] = mtime
                except (json.JSONDecodeError, OSError):
                    pass

        return sorted(_problem_cache.values(), key=lambda p: (p.get("page", 0), p.get("id", "")))


def _scan_progress() -> dict:
    """Scan the progress/ directory for progress JSON files."""
    progress_dir = SESSION_DIR / "progress"
    if not progress_dir.is_dir():
        return {}

    result = {}
    for entry in os.scandir(progress_dir):
        if entry.name.endswith(".json") and entry.is_file():
            try:
                data = json.loads((progress_dir / entry.name).read_text())
                criteria_name = data.get("criteria", entry.name.replace(".json", ""))
                result[criteria_name] = data
            except (json.JSONDecodeError, OSError):
                pass
    return result


def _read_selections() -> dict[str, bool]:
    """Read selections from selected.toml."""
    toml_path = SESSION_DIR / "selected.toml"
    if not toml_path.exists():
        return {}

    import tomllib
    try:
        with open(toml_path, "rb") as f:
            data = tomllib.load(f)
        return data.get("selections", {})
    except Exception:
        return {}


def _write_selections(selections: dict[str, bool]):
    """Write selections to selected.toml."""
    toml_path = SESSION_DIR / "selected.toml"
    lines = [
        "# Shears review selections",
        f"# Updated: {datetime.now(timezone.utc).isoformat()}",
        "",
        "[selections]",
    ]
    for pid in sorted(selections.keys()):
        val = "true" if selections[pid] else "false"
        lines.append(f"{pid} = {val}")

    toml_path.write_text("\n".join(lines) + "\n")


def _is_done() -> bool:
    """Check if all checker agents have completed."""
    return (SESSION_DIR / "done.marker").exists()


# ---------------------------------------------------------------------------
# Flask app factory
# ---------------------------------------------------------------------------

def create_app(plugin_root: Path) -> Flask:
    """Create the Flask app with correct template and static paths."""
    application = Flask(
        __name__,
        template_folder=str(plugin_root / "web" / "templates"),
        static_folder=str(plugin_root / "web" / "static"),
    )

    @application.route("/")
    def index():
        return render_template("index.html")

    @application.route("/api/problems")
    def api_problems():
        problems = _scan_problems()
        return jsonify({"problems": problems, "total": len(problems)})

    @application.route("/api/progress")
    def api_progress():
        progress = _scan_progress()
        all_done = _is_done()
        return jsonify({"criteria": progress, "all_done": all_done})

    @application.route("/api/status")
    def api_status():
        problems = _scan_problems()
        selections = _read_selections()
        selected_count = sum(1 for v in selections.values() if v)
        return jsonify({
            "total_problems": len(problems),
            "selected_count": selected_count,
            "all_done": _is_done(),
        })

    @application.route("/api/selections", methods=["GET"])
    def api_get_selections():
        return jsonify(_read_selections())

    @application.route("/api/selections", methods=["POST"])
    def api_post_selections():
        data = request.get_json()
        if not data or "problem_id" not in data:
            return jsonify({"error": "missing problem_id"}), 400
        selections = _read_selections()
        selections[data["problem_id"]] = bool(data.get("selected", False))
        _write_selections(selections)
        return jsonify({"ok": True})

    @application.route("/api/selections/bulk", methods=["POST"])
    def api_bulk_selections():
        data = request.get_json()
        if not data or "selections" not in data:
            return jsonify({"error": "missing selections"}), 400
        current = _read_selections()
        for pid, selected in data["selections"].items():
            current[pid] = bool(selected)
        _write_selections(current)
        return jsonify({"ok": True})

    @application.route("/pdf")
    def serve_pdf():
        if PDF_PATH and PDF_PATH.exists():
            return send_file(PDF_PATH, mimetype="application/pdf")
        return jsonify({"error": "PDF not found"}), 404

    @application.route("/api/locate")
    def api_locate():
        """Return PDF coordinates for a (file, line) pair using synctex.

        Query params: file, line_start, line_end (optional)
        Returns: {page, boxes: [{x, y, w, h}, ...]}
        Coordinates are in PDF points (72 dpi). Origin at top-left.
        """
        import subprocess
        file_arg = request.args.get("file")
        line_start = request.args.get("line_start", type=int)
        line_end = request.args.get("line_end", type=int) or line_start

        if not file_arg or not line_start or not PDF_PATH:
            return jsonify({"error": "missing parameters"}), 400

        # Resolve file relative to the PDF directory
        paper_root = PDF_PATH.parent
        target_file = paper_root / file_arg
        if not target_file.exists():
            return jsonify({"error": f"file not found: {file_arg}"}), 404

        boxes_by_page: dict[int, list[dict]] = {}
        for line in range(line_start, min(line_end + 1, line_start + 20)):
            try:
                result = subprocess.run(
                    ["synctex", "view", "-i", f"{line}:0:{target_file}",
                     "-o", str(PDF_PATH)],
                    capture_output=True, text=True, timeout=5,
                )
                if result.returncode != 0:
                    continue
                # Parse output: blocks of Page/x/y/h/v/W/H
                current = {}
                for ln in result.stdout.splitlines():
                    if ln.startswith("Page:"):
                        current = {"page": int(ln.split(":")[1].strip())}
                    elif ln.startswith("h:"):
                        current["h"] = float(ln.split(":")[1].strip())
                    elif ln.startswith("v:"):
                        current["v"] = float(ln.split(":")[1].strip())
                    elif ln.startswith("W:"):
                        current["W"] = float(ln.split(":")[1].strip())
                    elif ln.startswith("H:"):
                        current["H"] = float(ln.split(":")[1].strip())
                        # Box is now complete
                        if "page" in current:
                            page = current["page"]
                            boxes_by_page.setdefault(page, []).append({
                                "x": current["h"],
                                "y": current["v"] - current["H"],
                                "w": current["W"],
                                "h": current["H"],
                            })
                        current = {}
            except (subprocess.SubprocessError, ValueError):
                continue

        if not boxes_by_page:
            return jsonify({"error": "no matches found"}), 404

        # Pick the page with the most boxes (most likely the right one)
        primary_page = max(boxes_by_page, key=lambda p: len(boxes_by_page[p]))

        # Dedupe boxes (synctex returns many overlapping/identical sub-boxes per line)
        def _dedupe(boxes):
            seen = set()
            unique = []
            for b in boxes:
                key = (round(b["x"], 1), round(b["y"], 1), round(b["w"], 1), round(b["h"], 1))
                if key not in seen:
                    seen.add(key)
                    unique.append(b)
            return sorted(unique, key=lambda b: b["y"])

        return jsonify({
            "page": primary_page,
            "boxes": _dedupe(boxes_by_page[primary_page]),
        })

    return application


# ---------------------------------------------------------------------------
# Server startup
# ---------------------------------------------------------------------------

def find_free_port() -> int:
    """Find a free port on localhost."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    global SESSION_DIR, PDF_PATH

    parser = argparse.ArgumentParser(description="Shears review UI server")
    parser.add_argument("session_dir", help="Path to the session directory (.shears/results/<timestamp>/)")
    parser.add_argument("--pdf", help="Path to the PDF file")
    parser.add_argument("--port", type=int, default=0, help="Port (0 = auto)")
    parser.add_argument("--no-browser", action="store_true", help="Don't open browser")
    parser.add_argument("--plugin-root", help="Path to the plugin root directory")
    args = parser.parse_args()

    SESSION_DIR = Path(args.session_dir).resolve()
    if not SESSION_DIR.is_dir():
        SESSION_DIR.mkdir(parents=True, exist_ok=True)

    if args.pdf:
        PDF_PATH = Path(args.pdf).resolve()

    if args.plugin_root:
        plugin_root = Path(args.plugin_root).resolve()
    else:
        plugin_root = Path(__file__).resolve().parent.parent

    app = create_app(plugin_root)

    port = args.port or find_free_port()

    # Write port file so other tools can find it
    (SESSION_DIR / "ui_port").write_text(str(port))

    url = f"http://127.0.0.1:{port}"
    print(f"Shears review UI running at {url}")
    print(f"Session: {SESSION_DIR}")

    if not args.no_browser:
        threading.Timer(0.8, webbrowser.open, args=[url]).start()

    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
