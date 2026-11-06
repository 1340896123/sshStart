"""Install an already built site atomically; preserve other Caddy applications."""

import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile


def run(*args):
    subprocess.run(args, check=True)


def deploy(archive_name, snippet_name, release_id):
    if not re.fullmatch(r"\d{8}T\d{6}Z-[a-f0-9]{8}", release_id):
        raise ValueError("Invalid website release ID")
    site_root = Path("/var/www/sshstar")
    release_root = site_root / "releases" / release_id
    if release_root.exists():
        raise ValueError("Website release already exists")
    configuration = Path("/etc/caddy/Caddyfile")
    snippet = Path("/etc/caddy/sshstar-website.Caddyfile")
    config_before = configuration.read_bytes()
    snippet_before = snippet.read_bytes() if snippet.exists() else None
    import_line = b"import /etc/caddy/sshstar-website.Caddyfile"
    if b"sshstar.123756.xyz" in config_before and import_line not in config_before:
        raise RuntimeError("Domain already has an inline Caddy configuration; inspect before deployment")
    config_after = config_before
    if import_line not in config_before:
        config_after = config_before.rstrip() + b"\n\n" + import_line + b"\n"
    current = site_root / "current"
    if current.exists() and not current.is_symlink():
        raise RuntimeError("Expected current to be a symlink")
    previous_target = os.readlink(current) if current.is_symlink() else None

    with tarfile.open(archive_name, "r:gz") as archive:
        for member in archive.getmembers():
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or not (member.isfile() or member.isdir()):
                raise ValueError("Unsafe archive entry")
        release_root.mkdir(parents=True)
        archive.extractall(release_root)
    for path in [release_root, *release_root.rglob("*")]:
        path.chmod(0o755 if path.is_dir() else 0o644)
    for name in ["index.html", "404.html", "images/workspace.webp", "images/files.webp", "images/models.webp"]:
        if not (release_root / name).is_file():
            raise RuntimeError("Missing website file: " + name)
    metadata = json.loads((release_root / "release.json").read_text())
    for kind in ["exe", "msi"]:
        asset = metadata[kind]
        if Path(asset["name"]).name != asset["name"]:
            raise ValueError("Invalid asset name")
        path = release_root / "downloads" / asset["name"]
        if path.stat().st_size != asset["size"] or hashlib.sha256(path.read_bytes()).hexdigest() != asset["sha256"]:
            raise RuntimeError("Installer checksum verification failed: " + asset["name"])
    sums = (release_root / "downloads" / "SHA256SUMS.txt").read_text()
    for kind in ["exe", "msi"]:
        if metadata[kind]["sha256"] not in sums or metadata[kind]["name"] not in sums:
            raise RuntimeError("Missing installer checksum entry")

    backup = Path("/var/backups/sshstar-website") / release_id
    backup.mkdir(parents=True)
    (backup / "Caddyfile").write_bytes(config_before)
    if snippet_before is not None:
        (backup / "sshstar-website.Caddyfile").write_bytes(snippet_before)
    (backup / "previous-target.txt").write_text(previous_target or "")
    candidate = configuration.with_name("Caddyfile.sshstar-candidate")
    candidate.write_bytes(config_after)
    switched = False
    try:
        shutil.copyfile(snippet_name, snippet)
        snippet.chmod(0o644)
        run("caddy", "validate", "--config", str(candidate), "--adapter", "caddyfile")
        pending = site_root / ("current-" + release_id)
        pending.symlink_to(release_root)
        os.replace(pending, current)
        switched = True
        os.replace(candidate, configuration)
        run("caddy", "reload", "--config", str(configuration), "--adapter", "caddyfile", "--force")
    except Exception:
        configuration.write_bytes(config_before)
        if snippet_before is not None:
            snippet.write_bytes(snippet_before)
        elif snippet.exists():
            snippet.unlink()
        if switched:
            if previous_target:
                pending = site_root / ("rollback-" + release_id)
                pending.symlink_to(previous_target)
                os.replace(pending, current)
            else:
                current.unlink()
        subprocess.run(["caddy", "reload", "--config", str(configuration), "--adapter", "caddyfile", "--force"])
        raise
    finally:
        if candidate.exists():
            candidate.unlink()
    print(json.dumps({"release": release_id, "version": metadata["version"], "root": str(release_root), "previous": previous_target, "url": "https://sshstar.123756.xyz"}))


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("Usage: install-website.py ARCHIVE CADDY_SNIPPET RELEASE_ID")
    with open("/run/lock/sshstar-website.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        deploy(*sys.argv[1:])
