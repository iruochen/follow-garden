"""Create a reproducible store ZIP containing extension source and its license."""
import json
import re
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
version = json.loads((ROOT / "extension/manifest.json").read_text())["version"]
assert re.fullmatch(r"\d+\.\d+\.\d+", version), "Invalid release version"
assert json.loads((ROOT / "package.json").read_text())["version"] == version, "Package and manifest versions must match"
destination = ROOT / "dist" / f"follow-garden-{version}.zip"
destination.parent.mkdir(exist_ok=True)
with ZipFile(destination, "w", compression=ZIP_DEFLATED) as archive:
    paths = sorted((ROOT / "extension").rglob("*")) + [ROOT / "LICENSE"]
    for path in paths:
        if path.is_file():
            name = 'LICENSE' if path == ROOT / 'LICENSE' else path.relative_to(ROOT / 'extension').as_posix()
            info = ZipInfo(name, (2026, 10, 7, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, path.read_bytes())
print(destination)
