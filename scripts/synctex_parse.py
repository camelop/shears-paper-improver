#!/usr/bin/env python3
"""Parse a .synctex.gz file and produce a JSON mapping of PDF pages to source file line ranges."""

import argparse
import gzip
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path


def find_synctex_gz(pdf_path: Path) -> Path | None:
    """Find the .synctex.gz file corresponding to a PDF."""
    synctex_path = pdf_path.with_suffix(".synctex.gz")
    if synctex_path.exists():
        return synctex_path
    # Try without double suffix (e.g., main.synctex.gz for main.pdf)
    synctex_path = pdf_path.parent / (pdf_path.stem + ".synctex.gz")
    if synctex_path.exists():
        return synctex_path
    return None


def compile_with_synctex(main_tex: Path) -> bool:
    """Recompile the LaTeX document with synctex enabled."""
    result = subprocess.run(
        ["latexmk", "-pdf", "-synctex=1", "-interaction=nonstopmode", str(main_tex)],
        cwd=main_tex.parent,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def get_total_pages(pdf_path: Path) -> int:
    """Get total page count from a PDF using pdfinfo."""
    try:
        result = subprocess.run(
            ["pdfinfo", str(pdf_path)], capture_output=True, text=True
        )
        for line in result.stdout.splitlines():
            if line.startswith("Pages:"):
                return int(line.split(":")[1].strip())
    except (subprocess.SubprocessError, ValueError):
        pass
    return 0


def parse_synctex(synctex_path: Path, paper_root: Path, gap_tolerance: int = 3) -> dict:
    """Parse a .synctex.gz file and return page-to-source mapping.

    Returns a dict with keys:
        available: bool
        total_pages: int
        pages: {page_str: [{file, line_start, line_end}, ...]}
    """
    # Read the synctex file
    try:
        with gzip.open(synctex_path, "rt", errors="replace") as f:
            lines = f.readlines()
    except (OSError, gzip.BadGzipFile) as e:
        print(f"Error reading synctex file: {e}", file=sys.stderr)
        return {"available": False, "total_pages": 0, "pages": {}}

    # Phase 1: Parse Input tags -> file paths
    tag_to_file: dict[int, str] = {}
    for line in lines:
        if line.startswith("Input:"):
            parts = line.split(":", 2)
            if len(parts) >= 3:
                try:
                    tag = int(parts[1])
                    filepath = parts[2].strip()
                    tag_to_file[tag] = filepath
                except ValueError:
                    continue

    # Phase 2: Parse sheet blocks, collect (tag, line) per page
    page_sources: dict[int, list[tuple[str, int]]] = defaultdict(list)
    current_page: int | None = None
    record_chars = set("[(vhxkg$")

    for line in lines:
        if line.startswith("{") and not line.startswith("{\\"):
            try:
                current_page = int(line[1:].strip())
            except ValueError:
                pass
        elif line.startswith("}") and current_page is not None:
            try:
                int(line[1:].strip())
                current_page = None
            except ValueError:
                pass
        elif current_page is not None and len(line) > 1 and line[0] in record_chars:
            # Parse tag,line from the record
            rest = line[1:]
            comma_pos = rest.find(",")
            if comma_pos == -1:
                continue
            try:
                tag = int(rest[:comma_pos])
                colon_pos = rest.find(":", comma_pos)
                if colon_pos == -1:
                    lineno = int(rest[comma_pos + 1 :])
                else:
                    lineno = int(rest[comma_pos + 1 : colon_pos])
                if tag in tag_to_file and lineno > 0:
                    page_sources[current_page].append((tag_to_file[tag], lineno))
            except ValueError:
                continue

    # Phase 3: Aggregate into ranges per page per file
    paper_root_str = str(paper_root)
    pages_result: dict[str, list[dict]] = {}

    for page in sorted(page_sources.keys()):
        file_lines: dict[str, set[int]] = defaultdict(set)
        for filepath, lineno in page_sources[page]:
            # Filter: only user files (not texlive system files)
            if "/usr/share/" in filepath or "/var/lib/" in filepath:
                continue
            # Skip .aux, .out, .bbl files
            if any(filepath.endswith(ext) for ext in (".aux", ".out", ".bbl")):
                continue
            # Normalize path relative to paper root
            rel_path = _normalize_path(filepath, paper_root_str)
            if rel_path:
                file_lines[rel_path].add(lineno)

        page_entries = []
        for filepath in sorted(file_lines.keys()):
            ranges = _collapse_ranges(sorted(file_lines[filepath]), gap_tolerance)
            for start, end in ranges:
                page_entries.append(
                    {"file": filepath, "line_start": start, "line_end": end}
                )

        if page_entries:
            pages_result[str(page)] = page_entries

    # Determine total pages
    total_pages = max(page_sources.keys()) if page_sources else 0

    return {"available": True, "total_pages": total_pages, "pages": pages_result}


def _normalize_path(filepath: str, paper_root: str) -> str | None:
    """Normalize a synctex file path to be relative to paper root."""
    # Remove leading ./
    filepath = filepath.replace("/./", "/")
    # Try to make relative
    try:
        if filepath.startswith(paper_root):
            rel = filepath[len(paper_root) :]
            rel = rel.lstrip("/")
            # Strip leading ./
            if rel.startswith("./"):
                rel = rel[2:]
            return rel
    except (ValueError, IndexError):
        pass
    return None


def _collapse_ranges(sorted_lines: list[int], gap_tolerance: int) -> list[tuple[int, int]]:
    """Collapse a sorted list of line numbers into (start, end) ranges.

    Lines within gap_tolerance of each other are merged.
    """
    if not sorted_lines:
        return []
    ranges = []
    start = sorted_lines[0]
    end = sorted_lines[0]
    for line in sorted_lines[1:]:
        if line <= end + gap_tolerance:
            end = line
        else:
            ranges.append((start, end))
            start = line
            end = line
    ranges.append((start, end))
    return ranges


def main():
    parser = argparse.ArgumentParser(
        description="Parse synctex data and produce a page-to-source JSON mapping."
    )
    parser.add_argument("pdf_path", help="Path to the PDF file")
    parser.add_argument("--synctex", help="Explicit path to .synctex.gz file")
    parser.add_argument("--output", "-o", help="Output JSON path (default: stdout)")
    parser.add_argument(
        "--compile",
        action="store_true",
        help="Recompile with synctex if .synctex.gz is missing",
    )
    parser.add_argument(
        "--gap-tolerance",
        type=int,
        default=3,
        help="Max gap between line numbers to merge into one range (default: 3)",
    )
    args = parser.parse_args()

    pdf_path = Path(args.pdf_path).resolve()
    if not pdf_path.exists():
        print(f"Error: PDF not found: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    paper_root = pdf_path.parent

    # Find or compile synctex
    if args.synctex:
        synctex_path = Path(args.synctex).resolve()
    else:
        synctex_path = find_synctex_gz(pdf_path)

    if synctex_path is None or not synctex_path.exists():
        if args.compile:
            # Find main .tex file
            tex_files = list(paper_root.glob("*.tex"))
            main_tex = None
            for tf in tex_files:
                if tf.stem == pdf_path.stem:
                    main_tex = tf
                    break
            if main_tex is None and tex_files:
                main_tex = tex_files[0]
            if main_tex is None:
                print("Error: No .tex file found for recompilation", file=sys.stderr)
                sys.exit(1)
            print(f"Compiling {main_tex} with synctex...", file=sys.stderr)
            if not compile_with_synctex(main_tex):
                print("Warning: Compilation had errors", file=sys.stderr)
            synctex_path = find_synctex_gz(pdf_path)

    if synctex_path is None or not synctex_path.exists():
        result = {"available": False, "total_pages": get_total_pages(pdf_path), "pages": {}}
    else:
        result = parse_synctex(synctex_path, paper_root, args.gap_tolerance)
        # Use pdfinfo as fallback/verification for total_pages
        pdfinfo_pages = get_total_pages(pdf_path)
        if pdfinfo_pages > 0:
            result["total_pages"] = max(result["total_pages"], pdfinfo_pages)

    result["pdf_path"] = str(pdf_path.relative_to(paper_root))

    # Output
    output_json = json.dumps(result, indent=2)
    if args.output:
        Path(args.output).write_text(output_json + "\n")
        print(f"Written to {args.output}", file=sys.stderr)
    else:
        print(output_json)


if __name__ == "__main__":
    main()
