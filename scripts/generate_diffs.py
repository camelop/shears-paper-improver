#!/usr/bin/env python3
"""Generate comparison artifacts after Shears fixes have been applied."""

import argparse
import difflib
import shutil
import subprocess
import sys
from pathlib import Path


def find_modified_files(backup_dir: Path, paper_root: Path) -> list[tuple[Path, Path]]:
    """Find files that exist in both backup and current paper root.

    Returns list of (backup_file, current_file) tuples for files that differ.
    """
    pairs = []
    for backup_file in backup_dir.rglob("*.tex"):
        rel = backup_file.relative_to(backup_dir)
        current_file = paper_root / rel
        if current_file.exists():
            old = backup_file.read_text(errors="replace")
            new = current_file.read_text(errors="replace")
            if old != new:
                pairs.append((backup_file, current_file))
    return pairs


def generate_texdiff(backup_dir: Path, paper_root: Path, output_dir: Path) -> Path | None:
    """Generate unified diff of all modified tex files."""
    pairs = find_modified_files(backup_dir, paper_root)
    if not pairs:
        print("No modified files found.", file=sys.stderr)
        return None

    all_diffs = []
    for backup_file, current_file in pairs:
        rel = backup_file.relative_to(backup_dir)
        old_lines = backup_file.read_text(errors="replace").splitlines(keepends=True)
        new_lines = current_file.read_text(errors="replace").splitlines(keepends=True)
        diff = difflib.unified_diff(
            old_lines, new_lines,
            fromfile=f"a/{rel}",
            tofile=f"b/{rel}",
        )
        all_diffs.extend(diff)

    if not all_diffs:
        print("Files are identical.", file=sys.stderr)
        return None

    output_path = output_dir / "tex_diff.patch"
    output_path.write_text("".join(all_diffs))
    print(f"Tex diff written to {output_path}")
    return output_path


def generate_latexdiff(backup_dir: Path, paper_root: Path, main_tex: Path, output_dir: Path) -> Path | None:
    """Generate latexdiff PDF showing changes."""
    # Check if latexdiff is available
    if shutil.which("latexdiff") is None:
        print("latexdiff is not installed. Install with: sudo apt-get install latexdiff", file=sys.stderr)
        return None

    pairs = find_modified_files(backup_dir, paper_root)
    if not pairs:
        print("No modified files found.", file=sys.stderr)
        return None

    # For single-file changes, run latexdiff directly
    # For multi-file, we need latexdiff-vc or manual approach
    main_rel = main_tex.relative_to(paper_root)
    backup_main = backup_dir / main_rel

    if not backup_main.exists():
        # Main file wasn't modified; create a temp copy for latexdiff
        backup_main = backup_dir / main_rel
        backup_main.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(main_tex, backup_main)

    # Create a temporary directory for the diff document
    diff_dir = output_dir / "latexdiff_build"
    diff_dir.mkdir(parents=True, exist_ok=True)

    # Copy current paper to diff dir
    for f in paper_root.rglob("*"):
        if f.is_file() and not str(f).startswith(str(paper_root / ".shears")):
            rel = f.relative_to(paper_root)
            dest = diff_dir / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dest)

    # Run latexdiff on each modified file
    for backup_file, current_file in pairs:
        rel = backup_file.relative_to(backup_dir)
        diff_file = diff_dir / rel
        result = subprocess.run(
            ["latexdiff", str(backup_file), str(current_file)],
            capture_output=True, text=True,
        )
        if result.returncode == 0:
            diff_file.write_text(result.stdout)
        else:
            print(f"latexdiff failed for {rel}: {result.stderr[:200]}", file=sys.stderr)

    # Compile the diff document
    diff_main = diff_dir / main_rel
    result = subprocess.run(
        ["latexmk", "-pdf", "-interaction=nonstopmode", str(diff_main.name)],
        cwd=diff_dir,
        capture_output=True, text=True,
        timeout=300,
    )

    diff_pdf = diff_main.with_suffix(".pdf")
    if diff_pdf.exists():
        output_pdf = output_dir / "latexdiff.pdf"
        shutil.copy2(diff_pdf, output_pdf)
        print(f"Latexdiff PDF written to {output_pdf}")
        # Cleanup build dir
        shutil.rmtree(diff_dir, ignore_errors=True)
        return output_pdf
    else:
        print("Latexdiff compilation failed. Build files preserved at:", diff_dir, file=sys.stderr)
        return None


def generate_sidebyside(backup_dir: Path, paper_root: Path, main_tex: Path, output_dir: Path) -> tuple[Path | None, Path | None]:
    """Copy the old PDF from backup and reference the current PDF."""
    main_rel = main_tex.relative_to(paper_root)
    pdf_name = main_rel.with_suffix(".pdf").name

    # Old PDF from backup
    backup_pdf = backup_dir / pdf_name
    if backup_pdf.exists():
        before_pdf = output_dir / "before.pdf"
        shutil.copy2(backup_pdf, before_pdf)
    else:
        before_pdf = None
        print(f"No backup PDF found at {backup_pdf}", file=sys.stderr)

    # Current PDF
    current_pdf = paper_root / pdf_name
    if current_pdf.exists():
        after_pdf = output_dir / "after.pdf"
        shutil.copy2(current_pdf, after_pdf)
    else:
        after_pdf = None
        print(f"No current PDF found at {current_pdf}", file=sys.stderr)

    if before_pdf:
        print(f"Before PDF: {before_pdf}")
    if after_pdf:
        print(f"After PDF: {after_pdf}")

    return before_pdf, after_pdf


def main():
    parser = argparse.ArgumentParser(description="Generate comparison artifacts after fixes.")
    parser.add_argument("--backup-dir", required=True, help="Path to the backup directory")
    parser.add_argument("--paper-root", required=True, help="Path to the paper root directory")
    parser.add_argument("--main-tex", required=True, help="Path to the main .tex file")
    parser.add_argument("--mode", required=True, choices=["latexdiff", "side-by-side", "texdiff", "all"],
                        help="Comparison mode")
    parser.add_argument("--output-dir", required=True, help="Output directory for comparison artifacts")
    args = parser.parse_args()

    backup_dir = Path(args.backup_dir).resolve()
    paper_root = Path(args.paper_root).resolve()
    main_tex = Path(args.main_tex).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if not backup_dir.is_dir():
        print(f"Error: Backup directory not found: {backup_dir}", file=sys.stderr)
        sys.exit(1)

    mode = args.mode
    results = []

    if mode in ("texdiff", "all"):
        r = generate_texdiff(backup_dir, paper_root, output_dir)
        if r:
            results.append(f"Tex diff: {r}")

    if mode in ("latexdiff", "all"):
        r = generate_latexdiff(backup_dir, paper_root, main_tex, output_dir)
        if r:
            results.append(f"Latexdiff PDF: {r}")

    if mode in ("side-by-side", "all"):
        before, after = generate_sidebyside(backup_dir, paper_root, main_tex, output_dir)
        if before and after:
            results.append(f"Side-by-side: {before} vs {after}")

    if results:
        print("\nGenerated artifacts:")
        for r in results:
            print(f"  {r}")
    else:
        print("No artifacts generated.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
