---
name: shears-fix
description: "Apply fixes for selected paper quality problems from a shears-check session. Use when the user invokes /shears-fix. Reads selections from .shears/results, backs up affected files, groups fixes by file, applies them via Edit, recompiles, and generates comparison artifacts."
argument-hint: "[timestamp]"
allowed-tools: [Read, Glob, Grep, Bash, Write, Edit, Agent]
---

# Shears Fix — Apply Selected Paper Fixes

You are the orchestrator for applying paper quality fixes that were identified by `/shears-check` and selected by the user in the web UI.

The user invoked this with: $ARGUMENTS

The plugin root is available via the `${CLAUDE_PLUGIN_ROOT}` environment variable, automatically set by Claude Code when this skill runs.

## Phase 0: Load Session

1. If `$ARGUMENTS` contains a timestamp, use it. Otherwise, find the latest session:
```bash
ls -1d .shears/results/*/ 2>/dev/null | sort | tail -1
```

2. Set `SESSION_DIR` to that path.

3. Read `${SESSION_DIR}/selected.toml`. If the file doesn't exist or is empty:
   - Check if the web UI server is still running (check `${SESSION_DIR}/ui_port`)
   - If not running, start it:
     ```bash
     PDF_PATH=$(python3 -c "import json; d=json.load(open('${SESSION_DIR}/manifest.json')); print(d.get('pdf_path',''))")
     nohup python3 ${CLAUDE_PLUGIN_ROOT}/scripts/shears_server.py "${SESSION_DIR}" --pdf "${PDF_PATH}" --plugin-root ${CLAUDE_PLUGIN_ROOT} > /dev/null 2>&1 &
     ```
   - Tell the user: "No problems have been selected yet. Please open the web UI, select the problems you want to fix, and run `/shears-fix` again."
   - Stop here.

4. Parse `selected.toml` to get the list of selected problem IDs.

## Phase 1: Load Selected Problems

For each selected problem ID:
1. Read the corresponding `.md` file from `${SESSION_DIR}/check/`
2. Read the corresponding `.json` file to get structured data
3. If a file is missing, warn and skip that problem

Build a list of selected problems with their full details.

## Phase 2: Group by File and Detect Conflicts

1. Group problems by their target `.tex` file.
2. Within each file group, sort by `line_start`.
3. Detect overlapping line ranges: if fix A's `[line_start, line_end]` overlaps with fix B's range:
   - Keep the one with higher `confidence` score
   - Warn about the skipped fix
4. Report: "N problems selected across M files. K conflicts detected (resolved by confidence)."

## Phase 3: Backup

```bash
BACKUP_DIR=".shears/backups/$(date +%Y-%m-%d_%H-%M-%S)"
mkdir -p "${BACKUP_DIR}"
```

For each affected `.tex` file, copy it into the backup directory preserving the relative path:
```bash
mkdir -p "${BACKUP_DIR}/$(dirname <relative_path>)"
cp <file> "${BACKUP_DIR}/<relative_path>"
```

Also backup the current PDF:
```bash
cp <pdf_path> "${BACKUP_DIR}/"
```

Tell the user: "Backup created at ${BACKUP_DIR}"

## Phase 4: Apply Fixes

Load all selected problem descriptions (the `.md` files) into your context. These contain the full fix details.

Apply fixes **file by file**. For each affected file:
1. Read the current file content.
2. Collect all fixes targeting this file, sorted by `line_start` descending (bottom-to-top).
3. For each fix, use the `Edit` tool to apply the change:
   - Use the `original_text` from the JSON as `old_string`
   - Use the `suggested_fix` from the JSON as `new_string`
   - If `original_text` is not found exactly, search nearby lines. If still not found, skip and warn.
4. After applying all fixes to a file, move to the next file.

Working bottom-to-top ensures earlier line numbers remain valid after each edit.

## Phase 5: Recompile

Recompile the paper:
```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/compile_latex.py "${MAIN_TEX}"
```

If compilation fails:
- Report the errors.
- Ask the user: "Compilation failed after applying fixes. Would you like to restore from the backup at ${BACKUP_DIR}?"
- If yes, restore all files from backup.
- If no, leave the modified files for manual debugging.

## Phase 6: Ask Diff Mode

Present the user with the comparison options:

1. **latexdiff** — Generate a diff-annotated PDF with red (removed) / blue (added) markup. Requires `latexdiff` to be installed.
2. **Side-by-side PDF** — Produce both the old PDF (from backup) and the new PDF for manual comparison.
3. **Tex diff** — Generate a unified diff (patch format) of all modified `.tex` files.
4. **Skip** — No comparison needed.

## Phase 7: Generate Comparison

Based on the user's choice:

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/generate_diffs.py \
  --backup-dir "${BACKUP_DIR}" \
  --paper-root "${PAPER_ROOT}" \
  --main-tex "${MAIN_TEX}" \
  --mode <chosen_mode> \
  --output-dir ".shears/diffs/"
```

## Phase 8: Report

Summarize:
- How many fixes were applied successfully
- How many were skipped (conflicts, not found, etc.)
- Backup location: `${BACKUP_DIR}`
- Comparison artifacts location: `.shears/diffs/` (if generated)
- If latexdiff PDF was generated, offer to open it.
