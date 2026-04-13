#!/usr/bin/env python3
"""Compile a LaTeX document and report errors."""

import argparse
import re
import subprocess
import sys
from pathlib import Path


def compile_latex(main_tex: Path, synctex: bool = False) -> tuple[bool, str]:
    """Compile a LaTeX document using latexmk.

    Returns (success, message) where message contains error details on failure.
    """
    cmd = ["latexmk", "-pdf", "-interaction=nonstopmode"]
    if synctex:
        cmd.append("-synctex=1")
    cmd.append(str(main_tex.name))

    result = subprocess.run(
        cmd,
        cwd=main_tex.parent,
        capture_output=True,
        text=True,
        timeout=300,
    )

    if result.returncode == 0:
        pdf_path = main_tex.with_suffix(".pdf")
        return True, f"Successfully compiled to {pdf_path}"

    # Extract errors from log file
    log_path = main_tex.with_suffix(".log")
    errors = []
    if log_path.exists():
        errors = extract_errors(log_path)

    if errors:
        msg = "Compilation failed with errors:\n" + "\n".join(errors)
    else:
        msg = f"Compilation failed (exit code {result.returncode}).\nstderr: {result.stderr[-500:]}"

    return False, msg


def extract_errors(log_path: Path) -> list[str]:
    """Extract error messages from a LaTeX log file."""
    errors = []
    try:
        content = log_path.read_text(errors="replace")
    except OSError:
        return errors

    lines = content.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        # LaTeX errors start with !
        if line.startswith("!"):
            error_lines = [line]
            # Collect context lines (up to 5 more)
            for j in range(1, 6):
                if i + j < len(lines):
                    ctx = lines[i + j]
                    error_lines.append(ctx)
                    # Stop at the line number indicator
                    if re.match(r"l\.\d+", ctx):
                        break
            errors.append("\n".join(error_lines))
            i += len(error_lines)
        else:
            i += 1

    return errors[:10]  # Limit to first 10 errors


def main():
    parser = argparse.ArgumentParser(description="Compile a LaTeX document.")
    parser.add_argument("main_tex", help="Path to the main .tex file")
    parser.add_argument(
        "--synctex", action="store_true", help="Enable synctex output"
    )
    args = parser.parse_args()

    main_tex = Path(args.main_tex).resolve()
    if not main_tex.exists():
        print(f"Error: File not found: {main_tex}", file=sys.stderr)
        sys.exit(1)

    success, message = compile_latex(main_tex, args.synctex)
    print(message)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
