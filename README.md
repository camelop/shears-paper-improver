<div align="center">

<img src="docs/assets/logo.png" width="160" alt="Shears logo" />

# Shears — LaTeX Paper Improver

**A Claude Code plugin that checks and fixes LaTeX paper quality using configurable criteria, synctex-based PDF mapping, and a local web UI with inline PDF viewer.**

[Features](#features) · [Installation](#installation) · [Usage](#usage) · [Custom Criteria](#custom-criteria) · [How It Works](#how-it-works)

</div>

---

## Features

- **Two slash commands**: `/shears-paper-improver:shears-check` and `/shears-paper-improver:shears-fix`
- **Parallel criterion checking**: Each criterion runs as its own agent in parallel
- **Built-in criteria**: typo, grammar, term-consistency (extensible — drop a markdown file into `.shears/criteria/`)
- **Synctex-based PDF mapping**: Problems are tagged with exact PDF page numbers and coordinates
- **Local web UI with embedded PDF.js viewer**:
  - Live progress tracking as agents work
  - Severity and confidence badges on every problem
  - **Locate** button highlights the exact region on the PDF
  - Zoom, fit-to-width, keyboard shortcuts
  - Text-selectable, searchable PDF (Ctrl+F works)
  - Collapsible problem cards with diff-style fix preview
  - Checkbox selection persisted to `selected.toml`
- **Fix workflow**:
  - Backs up `.tex` files and PDF before editing
  - Groups fixes by file, applies bottom-to-top to preserve line numbers
  - Detects overlapping fixes (conflict resolution by confidence)
  - Recompiles the paper and offers three comparison modes: `latexdiff`, side-by-side PDFs, or unified `.tex` diff
  - Offers rollback on compilation failure

## Installation

### Quick start (one command)

```bash
git clone https://github.com/camelop/shears-paper-improver.git
cd shears-paper-improver && ./install.sh
```

The install script:
- Checks for required tools (`python3`, `latexmk`, `pdflatex`, `synctex`, `pdfinfo`, Flask) and offers to install any that are missing via your system package manager (`apt`, `brew`, `dnf`, `pacman` supported)
- Registers this repo as a local Claude Code marketplace
- Prints the 3 `/plugin` commands to finish setup inside Claude Code

Then inside Claude Code, run what the script prints:

```
/plugin marketplace add ~/.claude/plugins/local-marketplace
/plugin install shears-paper-improver@local-marketplace
/reload-plugins
```

That's it — the `/shears-paper-improver:shears-check` and `/shears-paper-improver:shears-fix` slash commands are now available.

### Prerequisites (manual)

If you prefer to install dependencies yourself:

**Linux (Debian/Ubuntu)**:
```bash
sudo apt-get install python3-flask latexmk texlive-latex-extra poppler-utils
# Optional for latexdiff comparison mode:
sudo apt-get install latexdiff
```

**macOS**:
```bash
brew install python poppler
brew install --cask mactex-no-gui
pip3 install flask
```

You also need [Claude Code](https://claude.com/claude-code) installed.

### Manual install (no script)

If you'd rather not run `install.sh`:

```bash
# 1. Clone the repo anywhere
git clone https://github.com/camelop/shears-paper-improver.git ~/shears-paper-improver

# 2. Create the marketplace wrapper (note: $HOME expands to your home dir)
mkdir -p ~/.claude/plugins/local-marketplace/.claude-plugin
cat > ~/.claude/plugins/local-marketplace/.claude-plugin/marketplace.json <<EOF
{
  "name": "local-marketplace",
  "owner": {"name": "local"},
  "plugins": [{
    "name": "shears-paper-improver",
    "description": "LaTeX paper quality checker and fixer",
    "source": "$HOME/shears-paper-improver",
    "category": "writing"
  }]
}
EOF

# 3. In Claude Code:
# /plugin marketplace add ~/.claude/plugins/local-marketplace
# /plugin install shears-paper-improver@local-marketplace
# /reload-plugins
```

## Usage

### Check a paper

```
cd /path/to/your/latex/paper
```

In Claude Code:
```
/shears-paper-improver:shears-check
```

Optional: pass a comma-separated list of criteria names to limit the check:
```
/shears-paper-improver:shears-check typo,grammar
```

This will:
1. Compile your paper with synctex enabled
2. Parse the synctex mapping (page ↔ source file:line)
3. Launch the local web UI in your browser
4. Spawn one checker agent per criterion, working in parallel

Review the problems in your browser. Click **Locate** on any card to highlight the region in the embedded PDF. Check/uncheck the ones you want to fix — selections are saved automatically.

### Apply selected fixes

```
/shears-paper-improver:shears-fix
```

This loads the latest session's `selected.toml`, backs up affected files, applies the fixes, recompiles, and lets you choose a comparison mode (`latexdiff`, side-by-side, or `.tex` diff).

Optional: pass a specific timestamp to target an older session:
```
/shears-paper-improver:shears-fix 2026-04-13_14-30-00
```

## Custom Criteria

Drop a markdown file into `.shears/criteria/` in your paper's root directory. Any file matching this format becomes a new criterion:

```markdown
# My Custom Check

## Description
What to look for.

## Scope
text      # or "all" to include math/commands

## Positive Examples (these ARE problems)
- ...

## Negative Examples (these are NOT problems)
- ...

## Checking Instructions
Step-by-step guide for the checker agent.
```

Built-in criteria live in the plugin's `criteria/` directory — use them as reference.

## How It Works

```
┌──────────────┐   compile     ┌──────────────┐
│  main.tex    │──────────────▶│ main.pdf     │
│  sections/*  │               │ main.synctex │
└──────────────┘               └──────┬───────┘
                                      │ parse
                                      ▼
                               ┌──────────────┐
                               │ page ↔ line  │
                               │   mapping    │
                               └──────┬───────┘
                                      │
                  ┌───────────────────┼───────────────────┐
                  ▼                   ▼                   ▼
          ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
          │ typo agent   │   │ grammar      │   │ term         │
          │ (parallel)   │   │ agent        │   │ consistency  │
          └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
                 │                   │                   │
                 └───────────────────┼───────────────────┘
                                     ▼
                            .shears/results/
                            ├── check/                  ── .md + .json pairs
                            ├── progress/               ── live progress
                            └── selected.toml           ── user's picks
                                     │
                                     ▼
                          ┌──────────────────────┐
                          │  Flask web UI        │
                          │  + PDF.js viewer     │
                          │  + synctex locate    │
                          └──────────────────────┘
```

- **Agents write one markdown file per problem** (plus a JSON sidecar for the web UI). The markdown is the source of truth for `/shears-fix` — it uses the exact `original_text` and `suggested_fix` from the JSON to drive edits.
- **Fixes are applied bottom-to-top** within each file so earlier line numbers remain valid after each edit.
- **The web UI polls** `/api/problems` and `/api/progress` every 2 seconds. When you click **Locate**, it calls `synctex view` to get exact PDF coordinates for your line, then overlays a highlight box on the embedded PDF.

## Project Layout

```
shears-paper-improver/
├── .claude-plugin/plugin.json    # plugin metadata
├── skills/
│   ├── shears-check/SKILL.md     # /shears-check orchestrator
│   └── shears-fix/SKILL.md       # /shears-fix orchestrator
├── agents/
│   └── criterion-checker.md      # per-criterion agent definition
├── criteria/                     # built-in criteria
│   ├── typo.md
│   ├── grammar.md
│   └── term-consistency.md
├── scripts/
│   ├── synctex_parse.py          # parse .synctex.gz → page mapping JSON
│   ├── compile_latex.py          # latexmk wrapper with error extraction
│   ├── shears_server.py          # Flask web server
│   └── generate_diffs.py         # latexdiff / side-by-side / texdiff
├── web/
│   ├── templates/index.html
│   └── static/
│       ├── app.js                # frontend SPA
│       ├── style.css
│       ├── pdf.min.mjs           # PDF.js 4.4.168
│       └── pdf.worker.min.mjs
└── docs/                         # GitHub Pages site
```

## Development

To make changes, edit files under `~/shears-paper-improver/` (or wherever you cloned it). Run `/reload-plugins` in Claude Code to pick up changes — no restart needed.

Built-in criteria can be edited directly in `criteria/`. The Flask server auto-caches with mtime, so refreshing the browser picks up new results instantly.

## License

MIT — see [LICENSE](LICENSE).

## Authors

- [Clive2312](https://github.com/Clive2312) &lt;clivehaha@outlook.com&gt;
- [littleround](https://github.com/camelop) &lt;23360163+camelop@users.noreply.github.com&gt;
- [Claude](https://claude.com/claude-code)

## Credits

- PDF rendering via [Mozilla PDF.js](https://mozilla.github.io/pdf.js/)
- Built as a [Claude Code](https://claude.com/claude-code) plugin
