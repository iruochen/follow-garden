"""Validate extension packaging, modules and CSP without third-party packages."""
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
manifest = json.loads((EXT / "manifest.json").read_text())
assert manifest["manifest_version"] == 3
assert set(manifest["permissions"]) == {"storage", "webRequest", "scripting"}
assert manifest["optional_host_permissions"] == ["https://x.com/*", "https://api.x.com/*", "https://api.twitterapi.io/*"]
for name in [manifest["background"]["service_worker"], manifest["action"]["default_popup"], "ui/index.html"]:
    assert (EXT / name).is_file(), name
assert manifest["default_locale"] == "en"
for size, target in manifest["icons"].items():
    assert size in ("16", "32", "48", "128") and (EXT / target).is_file()
modules = list(EXT.rglob("*.js"))
for path in modules:
    subprocess.run(["node", "--check", str(path)], check=True, capture_output=True)
    source = path.read_text()
    for target in re.findall(r"from\s+['\"](\.[^'\"]+)['\"]", source):
        assert (path.parent / target).resolve().is_file(), (path, target)
    assert not re.search(r"\beval\s*\(|new\s+Function\b", source), path
for path in EXT.rglob("*.html"):
    source = path.read_text()
    assert not re.search(r"\son\w+\s*=|<script[^>]*>\s*[^<\s]", source), path
    for target in re.findall(r'(?:src|href)="([^"#]+)"', source):
        assert not target.startswith(("http:", "https:")), path
        assert (path.parent / target).is_file(), (path, target)
print(f"OK: MV3 manifest, {len(modules)} JavaScript modules, local assets and CSP-compatible HTML.")
print("Scope: static checks; Chrome installation and real X endpoints are not verified.")
