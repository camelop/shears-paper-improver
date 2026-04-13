---
name: shears-check
description: "Run quality checks on a LaTeX paper. Use when the user invokes /shears-check. Checks .tex source files against built-in and custom criteria (typo, grammar, term-consistency), maps problems to PDF pages via synctex, writes results, and opens a local web UI for review and selection."
argument-hint: "[criteria1,criteria2,...] (empty = all)"
allowed-tools: [Read, Glob, Grep, Bash, Agent, Write]
---

# Shears Check — LaTeX Paper Quality Checker

You are the orchestrator for Shears paper quality checking. Follow these phases exactly.

The user invoked this with: $ARGUMENTS

The plugin root is available via the `${CLAUDE_PLUGIN_ROOT}` environment variable, automatically set by Claude Code when this skill runs.

## Phase 0: Parse Arguments

Parse `$ARGUMENTS` for a comma-separated list of criteria names. If empty, use all available criteria.

## Phase 1: Locate the Paper

Find the main `.tex` file in the current working directory:
1. Glob for `*.tex` files in the current directory.
2. Read each one and look for `\begin{document}`.
3. If exactly one file contains it, use that as `MAIN_TEX`.
4. If multiple match, prefer the one whose name matches an existing PDF, or ask the user.

Set `PAPER_ROOT` to the directory containing `MAIN_TEX`.

## Phase 2: Initialize

Create the session directory:
```bash
TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
SESSION_DIR="${PAPER_ROOT}/.shears/results/${TIMESTAMP}"
mkdir -p "${SESSION_DIR}/check" "${SESSION_DIR}/progress"
mkdir -p "${PAPER_ROOT}/.shears/criteria"
```

## Phase 3: Compile with Synctex

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/compile_latex.py "${MAIN_TEX}" --synctex
```

If compilation fails, report the errors to the user and stop.

## Phase 4: Parse Synctex

```bash
PDF_PATH="${MAIN_TEX%.tex}.pdf"
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/synctex_parse.py "${PDF_PATH}" -o "${SESSION_DIR}/manifest.json"
```

Read the manifest.json to get the synctex mapping and total pages.

## Phase 5: Gather Criteria

1. Read built-in criteria from `${CLAUDE_PLUGIN_ROOT}/criteria/*.md`
2. Read user custom criteria from `${PAPER_ROOT}/.shears/criteria/*.md`
3. If `$ARGUMENTS` specified criteria names, filter to only those.
4. If no criteria match, report error and stop.

For each criterion, read the full markdown content.

## Phase 6: Trace Source Files

Starting from `MAIN_TEX`, trace all `\input{}` and `\include{}` commands recursively to build the complete list of `.tex` source files. Read the content of each file.

## Phase 7: Launch Web UI (BEFORE spawning agents)

Start the web server in the background **before** spawning checker agents. This lets the user track progress live as agents work.

```bash
nohup python3 ${CLAUDE_PLUGIN_ROOT}/scripts/shears_server.py \
  "${SESSION_DIR}" \
  --pdf "${PDF_PATH}" \
  --plugin-root ${CLAUDE_PLUGIN_ROOT} \
  > /dev/null 2>&1 &
SERVER_PID=$!
sleep 1
PORT=$(cat "${SESSION_DIR}/ui_port")
xdg-open "http://127.0.0.1:${PORT}" 2>/dev/null || open "http://127.0.0.1:${PORT}" 2>/dev/null || echo "Open http://127.0.0.1:${PORT} in your browser"
```

Also pre-create the progress files for all criteria so the UI can show "pending" status from the start:
```bash
for criterion in <criteria_names>; do
  cat > "${SESSION_DIR}/progress/${criterion}.json" << EOF
{"criteria": "${criterion}", "current_page": 0, "total_pages": <total>, "status": "pending", "problems_found": 0}
EOF
done
```

Tell the user: "Web UI is running at http://127.0.0.1:${PORT} — open it now to watch progress live as the checker agents work."

## Phase 8: Spawn Checker Agents

Now spawn agents. For each criterion, spawn a `criterion-checker` agent using the Agent tool. **Spawn all agents in parallel** (in a single message with multiple Agent tool calls).

Each agent's prompt must include:
1. The criterion markdown content (full text)
2. All source file contents with their paths (provide file path and full content for each)
3. The synctex page mapping (from manifest.json)
4. The output directory: `${SESSION_DIR}/check/`
5. The progress directory: `${SESSION_DIR}/progress/`
6. The criterion name (for file naming)
7. The total number of pages

Tell each agent to follow the instructions in its agent definition (`criterion-checker.md`).

Important: Give each agent explicit file-writing instructions:
- Result markdown files go in: `${SESSION_DIR}/check/<criteria>_p<page>_<id>.md`
- Result JSON sidecars go in: `${SESSION_DIR}/check/<criteria>_p<page>_<id>.json`
- Progress file goes in: `${SESSION_DIR}/progress/<criteria>.json` (update after each page; set status to "running" when starting, "completed" when done)

## Phase 9: Wait and Report

Wait for all agents to complete. Once all agents have returned, write a completion marker:
```bash
echo "done" > "${SESSION_DIR}/done.marker"
```

Tell the user:
- N criteria checked across M pages, K problems found
- Web UI is at `http://127.0.0.1:${PORT}` — review problems and select the ones to fix
- When ready, run `/shears-fix` to apply the selected fixes
