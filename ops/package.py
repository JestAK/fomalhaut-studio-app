"""Build the VPS release from an explicit allowlist; never include live data/secrets."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
target = root / "dist" / "Fomalhaut-Studio.zip"
files = [root / name for name in (
    "package.json", "README.md", "DEPLOY_GITHUB_UK.md", "NOTION_UK.md", "START_AWS_UK.md", "README_UK.md", "BRAND.md", "Dockerfile", "compose.yaml",
    "Caddyfile", ".env.example", ".dockerignore", ".gitignore",
)]
for directory in ("server", "dist", "ops", "tests"):
    files.extend(p for p in (root / directory).rglob("*")
                 if p.is_file() and not p.is_symlink() and p.suffix != ".zip"
                 and ".before-" not in p.name and "__pycache__" not in p.parts and not p.name.startswith("qa-"))
with ZipFile(target, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
    for source in sorted(files):
        entry = ZipInfo("Fomalhaut-Studio/" + source.relative_to(root).as_posix(),
                        date_time=(2026, 1, 1, 0, 0, 0))
        entry.compress_type = ZIP_DEFLATED
        entry.external_attr = (0o100755 if source.suffix == ".sh" else 0o100644) << 16
        archive.writestr(entry, source.read_bytes())
with ZipFile(target) as archive:
    assert archive.testzip() is None
print(f"Server package: {target} ({target.stat().st_size} bytes)")
