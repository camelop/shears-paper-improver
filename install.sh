#!/usr/bin/env bash
# Shears Paper Improver — installer
# Sets up dependencies, registers the plugin as a local Claude Code marketplace,
# and prints the final commands to run inside Claude Code.
set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve absolute path of this repo (where install.sh lives)
# ---------------------------------------------------------------------------
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKETPLACE_DIR="${HOME}/.claude/plugins/local-marketplace"
MARKETPLACE_JSON="${MARKETPLACE_DIR}/.claude-plugin/marketplace.json"

# ---------------------------------------------------------------------------
# Color helpers
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; RESET='\033[0m'; BOLD='\033[1m'
else
  BLUE=''; GREEN=''; YELLOW=''; RED=''; RESET=''; BOLD=''
fi

info()  { echo -e "${BLUE}[info]${RESET} $*"; }
ok()    { echo -e "${GREEN}[ok]${RESET}   $*"; }
warn()  { echo -e "${YELLOW}[warn]${RESET} $*"; }
err()   { echo -e "${RED}[err]${RESET}  $*" >&2; }
head()  { echo -e "\n${BOLD}$*${RESET}"; }

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
  if command -v brew >/dev/null 2>&1; then PKG_MANAGER="brew"; fi
fi

head "Shears Paper Improver installer"
info "Repo directory: ${REPO_DIR}"
info "Platform: ${OS} (package manager: ${PKG_MANAGER:-none detected})"

# ---------------------------------------------------------------------------
# Step 1: check prerequisites
# ---------------------------------------------------------------------------
head "Step 1/3 — Checking prerequisites"

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

# Flask is a Python module, not a binary
if python3 -c "import flask" >/dev/null 2>&1; then
  ok "python3-flask found ($(python3 -c 'import flask; print(flask.__version__)'))"
else
  warn "python3-flask NOT found"
  MISSING+=("python3-flask")
fi

# latexdiff is optional
if command -v latexdiff >/dev/null 2>&1; then
  ok "latexdiff found (optional — enables latexdiff comparison mode)"
else
  warn "latexdiff not found (optional — only needed for latexdiff comparison mode)"
fi

# ---------------------------------------------------------------------------
# Step 1b: offer to install missing required deps
# ---------------------------------------------------------------------------
if [[ ${#MISSING[@]} -gt 0 ]]; then
  head "Missing required dependencies: ${MISSING[*]}"
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
      echo "The following command can install them:"
      echo -e "  ${BOLD}sudo apt-get install -y ${APT_PKGS[*]}${RESET}"
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
      for m in "${MISSING[@]}"; do
        case "$m" in
          python3) BREW_PKGS+=("python@3.12") ;;
          python3-flask) :;;  # install via pip after
          latexmk|pdflatex|synctex) INSTALL_TEX=1 ;;
          pdfinfo) BREW_PKGS+=("poppler") ;;
        esac
      done
      [[ $INSTALL_TEX -eq 1 ]] && BREW_PKGS+=("--cask mactex-no-gui")
      echo "The following commands will install them:"
      if [[ ${#BREW_PKGS[@]} -gt 0 ]]; then
        echo -e "  ${BOLD}brew install ${BREW_PKGS[*]}${RESET}"
      fi
      if printf '%s\n' "${MISSING[@]}" | grep -q '^python3-flask$'; then
        echo -e "  ${BOLD}pip3 install flask${RESET}"
      fi
      read -rp "Run them now? [y/N] " reply
      if [[ "${reply,,}" == "y" ]]; then
        [[ ${#BREW_PKGS[@]} -gt 0 ]] && brew install "${BREW_PKGS[@]}"
        if printf '%s\n' "${MISSING[@]}" | grep -q '^python3-flask$'; then
          pip3 install flask
        fi
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
      err "Unknown package manager. Please install these manually: ${MISSING[*]}"
      exit 1
      ;;
  esac
fi

# ---------------------------------------------------------------------------
# Step 2: register the local marketplace
# ---------------------------------------------------------------------------
head "Step 2/3 — Registering local Claude Code marketplace"

mkdir -p "${MARKETPLACE_DIR}/.claude-plugin"

# If marketplace.json exists and already lists this plugin, we update the source
if [[ -f "$MARKETPLACE_JSON" ]]; then
  info "Existing marketplace found — merging plugin entry"
  # Use python to safely update JSON
  python3 - "$MARKETPLACE_JSON" "$REPO_DIR" <<'PY'
import json, sys
path, repo = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
data.setdefault("name", "local-marketplace")
data.setdefault("owner", {"name": "local"})
plugins = data.setdefault("plugins", [])
entry = {
    "name": "shears-paper-improver",
    "description": "Check and fix LaTeX paper quality with configurable criteria, synctex mapping, and a local web UI.",
    "source": repo,
    "category": "writing",
}
updated = False
for i, p in enumerate(plugins):
    if p.get("name") == "shears-paper-improver":
        plugins[i] = entry
        updated = True
        break
if not updated:
    plugins.append(entry)
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print("Updated" if updated else "Added")
PY
else
  cat > "$MARKETPLACE_JSON" <<EOF
{
  "name": "local-marketplace",
  "owner": {"name": "local"},
  "plugins": [
    {
      "name": "shears-paper-improver",
      "description": "Check and fix LaTeX paper quality with configurable criteria, synctex mapping, and a local web UI.",
      "source": "${REPO_DIR}",
      "category": "writing"
    }
  ]
}
EOF
fi

ok "Marketplace config written to ${MARKETPLACE_JSON}"

# ---------------------------------------------------------------------------
# Step 3: tell the user what to run in Claude Code
# ---------------------------------------------------------------------------
head "Step 3/3 — Finish in Claude Code"
cat <<EOF

Run these commands inside Claude Code:

  ${BOLD}/plugin marketplace add ~/.claude/plugins/local-marketplace${RESET}
  ${BOLD}/plugin install shears-paper-improver@local-marketplace${RESET}
  ${BOLD}/reload-plugins${RESET}

If the marketplace was already registered, you can skip the first command —
/reload-plugins alone picks up updates to the plugin source.

After that, in any LaTeX paper directory:

  ${BOLD}/shears-paper-improver:shears-check${RESET}        Check for problems
  ${BOLD}/shears-paper-improver:shears-fix${RESET}          Apply selected fixes

Happy editing!
EOF
