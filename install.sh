#!/usr/bin/env bash
# Shears Paper Improver — installer / upgrader
# Works for fresh installs and as an upgrade path (re-run after `git pull`).
set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve absolute path of this repo (where install.sh lives)
# ---------------------------------------------------------------------------
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKETPLACE_DIR="${HOME}/.claude/plugins/local-marketplace"
MARKETPLACE_JSON="${MARKETPLACE_DIR}/.claude-plugin/marketplace.json"
PLUGIN_LINK="${MARKETPLACE_DIR}/plugins/shears-paper-improver"

# ---------------------------------------------------------------------------
# Color helpers — use ANSI-C quoting ($'...') so escapes work in heredocs too
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  BLUE=$'\033[0;34m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'
  RED=$'\033[0;31m';  RESET=$'\033[0m';    BOLD=$'\033[1m'
else
  BLUE=''; GREEN=''; YELLOW=''; RED=''; RESET=''; BOLD=''
fi

info()  { printf '%s[info]%s %s\n'  "$BLUE"   "$RESET" "$*"; }
ok()    { printf '%s[ok]%s   %s\n'  "$GREEN"  "$RESET" "$*"; }
warn()  { printf '%s[warn]%s %s\n'  "$YELLOW" "$RESET" "$*"; }
err()   { printf '%s[err]%s  %s\n'  "$RED"    "$RESET" "$*" >&2; }
sect()  { printf '\n%s%s%s\n'       "$BOLD"   "$*"     "$RESET"; }

# ---------------------------------------------------------------------------
# Detect fresh install vs upgrade
# ---------------------------------------------------------------------------
MODE="install"
if [[ -f "$MARKETPLACE_JSON" ]] && grep -q '"shears-paper-improver"' "$MARKETPLACE_JSON" 2>/dev/null; then
  MODE="upgrade"
fi

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------
OS="unknown"
PKG_MANAGER=""
if [[ "$(uname)" == "Linux" ]]; then
  OS="linux"
  if command -v apt-get >/dev/null 2>&1; then PKG_MANAGER="apt"
  elif command -v dnf >/dev/null 2>&1; then PKG_MANAGER="dnf"
  elif command -v pacman >/dev/null 2>&1; then PKG_MANAGER="pacman"
  fi
elif [[ "$(uname)" == "Darwin" ]]; then
  OS="macos"
  command -v brew >/dev/null 2>&1 && PKG_MANAGER="brew"
fi

if [[ "$MODE" == "upgrade" ]]; then
  sect "Shears Paper Improver — upgrading existing install"
else
  sect "Shears Paper Improver — installer"
fi
info "Repo directory: ${REPO_DIR}"
info "Platform: ${OS} (package manager: ${PKG_MANAGER:-none detected})"

# ---------------------------------------------------------------------------
# Optional: pull latest changes on upgrade
# ---------------------------------------------------------------------------
if [[ "$MODE" == "upgrade" ]] && [[ -d "${REPO_DIR}/.git" ]]; then
  if git -C "$REPO_DIR" diff --quiet && git -C "$REPO_DIR" diff --cached --quiet; then
    info "Local repo is clean. Checking for updates..."
    if git -C "$REPO_DIR" remote -v | grep -q origin; then
      read -rp "Run 'git pull' to fetch latest changes? [Y/n] " reply
      reply="${reply:-y}"
      if [[ "${reply,,}" == "y" ]]; then
        git -C "$REPO_DIR" pull --ff-only || warn "git pull failed — continuing with current HEAD"
      fi
    fi
  else
    warn "Local repo has uncommitted changes — skipping git pull"
  fi
fi

# ---------------------------------------------------------------------------
# Step 1: check prerequisites
# ---------------------------------------------------------------------------
sect "Step 1/3 — Checking prerequisites"

MISSING=()
check_cmd() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    ok "$name found: $(command -v "$name")"
  else
    warn "$name NOT found"
    MISSING+=("$name")
  fi
}

check_cmd python3
check_cmd latexmk
check_cmd pdflatex
check_cmd synctex
check_cmd pdfinfo

if python3 -c "import flask" >/dev/null 2>&1; then
  ok "python3-flask found ($(python3 -c 'import importlib.metadata; print(importlib.metadata.version("flask"))' 2>/dev/null || echo 'version?'))"
else
  warn "python3-flask NOT found"
  MISSING+=("python3-flask")
fi

if command -v latexdiff >/dev/null 2>&1; then
  ok "latexdiff found (optional)"
else
  warn "latexdiff not found (optional — only needed for latexdiff comparison mode)"
fi

# ---------------------------------------------------------------------------
# Step 1b: offer to install missing required deps
# ---------------------------------------------------------------------------
if [[ ${#MISSING[@]} -gt 0 ]]; then
  sect "Missing required dependencies: ${MISSING[*]}"
  case "$PKG_MANAGER" in
    apt)
      APT_PKGS=()
      for m in "${MISSING[@]}"; do
        case "$m" in
          python3) APT_PKGS+=("python3") ;;
          python3-flask) APT_PKGS+=("python3-flask") ;;
          latexmk) APT_PKGS+=("latexmk") ;;
          pdflatex) APT_PKGS+=("texlive-latex-base" "texlive-latex-extra") ;;
          synctex) APT_PKGS+=("texlive-binaries") ;;
          pdfinfo) APT_PKGS+=("poppler-utils") ;;
        esac
      done
      printf '  %ssudo apt-get install -y %s%s\n' "$BOLD" "${APT_PKGS[*]}" "$RESET"
      read -rp "Run it now? [y/N] " reply
      if [[ "${reply,,}" == "y" ]]; then
        sudo apt-get update
        sudo apt-get install -y "${APT_PKGS[@]}"
      else
        err "Skipping install. Re-run this script after installing manually."
        exit 1
      fi
      ;;
    brew)
      BREW_PKGS=()
      INSTALL_TEX=0
      NEED_FLASK=0
      for m in "${MISSING[@]}"; do
        case "$m" in
          python3) BREW_PKGS+=("python@3.12") ;;
          python3-flask) NEED_FLASK=1 ;;
          latexmk|pdflatex|synctex) INSTALL_TEX=1 ;;
          pdfinfo) BREW_PKGS+=("poppler") ;;
        esac
      done
      [[ ${#BREW_PKGS[@]} -gt 0 ]] && printf '  %sbrew install %s%s\n' "$BOLD" "${BREW_PKGS[*]}" "$RESET"
      [[ $INSTALL_TEX -eq 1 ]] && printf '  %sbrew install --cask mactex-no-gui%s\n' "$BOLD" "$RESET"
      [[ $NEED_FLASK -eq 1 ]] && printf '  %spip3 install flask%s\n' "$BOLD" "$RESET"
      read -rp "Run them now? [y/N] " reply
      if [[ "${reply,,}" == "y" ]]; then
        [[ ${#BREW_PKGS[@]} -gt 0 ]] && brew install "${BREW_PKGS[@]}"
        [[ $INSTALL_TEX -eq 1 ]] && brew install --cask mactex-no-gui
        [[ $NEED_FLASK -eq 1 ]] && pip3 install flask
      else
        err "Skipping install. Re-run this script after installing manually."
        exit 1
      fi
      ;;
    dnf)
      echo "Try: sudo dnf install python3 python3-flask texlive-scheme-basic texlive-latexmk poppler-utils"
      err "Please install manually and re-run."
      exit 1
      ;;
    pacman)
      echo "Try: sudo pacman -S python python-flask texlive-most texlive-binextra poppler"
      err "Please install manually and re-run."
      exit 1
      ;;
    *)
      err "Unknown package manager. Please install manually: ${MISSING[*]}"
      exit 1
      ;;
  esac
fi

# ---------------------------------------------------------------------------
# Step 2: register the local marketplace
#
# Claude Code's marketplace schema requires the plugin source to be a RELATIVE
# path inside the marketplace directory. We achieve that with a symlink from
# the marketplace's plugins/ subdir to this repo, then reference it as
# "./plugins/shears-paper-improver" in marketplace.json.
# ---------------------------------------------------------------------------
sect "Step 2/3 — Registering local Claude Code marketplace"

mkdir -p "${MARKETPLACE_DIR}/.claude-plugin" "${MARKETPLACE_DIR}/plugins"

# Create or refresh the symlink
if [[ -L "$PLUGIN_LINK" ]]; then
  existing_target="$(readlink -f "$PLUGIN_LINK")"
  if [[ "$existing_target" == "$REPO_DIR" ]]; then
    ok "Plugin symlink already points to this repo"
  else
    info "Updating plugin symlink from ${existing_target} to ${REPO_DIR}"
    rm "$PLUGIN_LINK"
    ln -s "$REPO_DIR" "$PLUGIN_LINK"
  fi
elif [[ -e "$PLUGIN_LINK" ]]; then
  warn "${PLUGIN_LINK} exists but is not a symlink — leaving it alone."
  warn "Please remove it manually if you want this install to manage it."
else
  ln -s "$REPO_DIR" "$PLUGIN_LINK"
  ok "Created plugin symlink: ${PLUGIN_LINK} -> ${REPO_DIR}"
fi

# Write/merge marketplace.json using Python for safe JSON handling
python3 - "$MARKETPLACE_JSON" <<'PY'
import json, os, sys
path = sys.argv[1]
if os.path.exists(path):
    with open(path) as f:
        try:
            data = json.load(f)
        except Exception:
            data = {}
else:
    data = {}

data.setdefault("name", "local-marketplace")
data.setdefault("owner", {"name": "local"})
plugins = data.setdefault("plugins", [])

entry = {
    "name": "shears-paper-improver",
    "description": "Check and fix LaTeX paper quality with configurable criteria, synctex mapping, and a local web UI.",
    "source": "./plugins/shears-paper-improver",
    "category": "writing",
}

# Remove any existing entry (including legacy ones with absolute paths)
plugins[:] = [p for p in plugins if p.get("name") != "shears-paper-improver"]
plugins.append(entry)

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print("Wrote", path)
PY

ok "Marketplace config ready at ${MARKETPLACE_JSON}"

# ---------------------------------------------------------------------------
# Step 3: tell the user what to run in Claude Code
# ---------------------------------------------------------------------------
sect "Step 3/3 — Finish in Claude Code"

if [[ "$MODE" == "upgrade" ]]; then
  cat <<EOF

Upgrade in place. Run inside Claude Code:

  ${BOLD}/reload-plugins${RESET}

That's it — the plugin source is symlinked, so /reload-plugins picks up any
changes pulled with git.

If Claude Code complains that the plugin isn't known, re-register it:

  ${BOLD}/plugin marketplace add ~/.claude/plugins/local-marketplace${RESET}
  ${BOLD}/plugin install shears-paper-improver@local-marketplace${RESET}
  ${BOLD}/reload-plugins${RESET}
EOF
else
  cat <<EOF

Fresh install. Run these commands inside Claude Code:

  ${BOLD}/plugin marketplace add ~/.claude/plugins/local-marketplace${RESET}
  ${BOLD}/plugin install shears-paper-improver@local-marketplace${RESET}
  ${BOLD}/reload-plugins${RESET}

Then, in any LaTeX paper directory:

  ${BOLD}/shears-paper-improver:shears-check${RESET}        Check for problems
  ${BOLD}/shears-paper-improver:shears-fix${RESET}          Apply selected fixes

Happy editing!
EOF
fi
