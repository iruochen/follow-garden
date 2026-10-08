"""Check required documents and relative Markdown links; no dependencies."""

from pathlib import Path
import re
import sys
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
REQUIRED = (
    "README.md", "LICENSE", "CONTRIBUTING.md", "SECURITY.md",
    "CODE_OF_CONDUCT.md", "README.zh-CN.md", "CONTRIBUTING.zh-CN.md",
    "SECURITY.zh-CN.md", "CODE_OF_CONDUCT.zh-CN.md", "docs/privacy.md",
    "docs/privacy.zh-CN.md", "docs/architecture.md", "docs/architecture.zh-CN.md",
    ".github/pull_request_template.md",
    ".github/ISSUE_TEMPLATE/bug_report.md",
    ".github/ISSUE_TEMPLATE/feature_request.md",
)


def main():
    errors = []
    for name in REQUIRED:
        path = ROOT / name
        if not path.is_file() or not path.read_text(encoding="utf-8").strip():
            errors.append(f"Missing or empty: {name}")

    documents = list(ROOT.rglob("*.md"))
    checked = 0
    for path in documents:
        if any(part in {".git", "work", "node_modules", "private-data"}
               for part in path.relative_to(ROOT).parts):
            continue
        relative = path.relative_to(ROOT).as_posix()
        if relative == "AGENTS.md" or relative.startswith("design/") or (relative.startswith("docs/") and relative not in REQUIRED):
            continue
        checked += 1
        content = path.read_text(encoding="utf-8")
        for match in re.finditer(r"\[[^\]]*\]\(([^)]+)\)", content):
            target = match.group(1).strip().split("#", 1)[0]
            if not target or re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target):
                continue
            resolved = (path.parent / unquote(target)).resolve()
            if not resolved.is_relative_to(ROOT) or not resolved.exists():
                errors.append(f"Broken local link in {path.relative_to(ROOT)}: {target}")

    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"OK: {len(REQUIRED)} required documents; {checked} Markdown files checked.")
    print("Scope: document structure and local links only; no extension or API verification.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
