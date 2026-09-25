#!/usr/bin/env python3
"""Crea un respaldo recuperable de AlertAR sin detener el servicio."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import socket
import sqlite3
import subprocess
import tarfile
import tempfile
from pathlib import Path, PurePosixPath


PROJECT = Path("/home/agusttin/Ciudad_Inteligente")
BACKUPS = PROJECT / "backups"
DATABASE = Path("/var/lib/alertar/alertar.db")

SOURCES = (
    PROJECT,
    Path("/opt/alertar/api"),
    Path("/etc/alertar-api.env"),
    Path("/etc/alertar-device.env"),
    Path("/etc/systemd/system/alertar-api.service"),
    Path("/etc/systemd/system/alertar-api.service.d"),
    Path("/usr/local/libexec/alertar-tailscale-watchdog.py"),
    Path("/etc/systemd/system/alertar-tailscale-watchdog.service"),
    Path("/etc/systemd/system/alertar-tailscale-watchdog.timer"),
    Path("/var/lib/tailscale/tailscaled.state"),
    Path("/etc/default/tailscaled"),
    Path("/etc/systemd/system/tailscaled.service.d"),
)

EXCLUDED_NAMES = {
    ".venv",
    "__pycache__",
    "backups",
    "paquete.tar.gz",
}


def excluded(info: tarfile.TarInfo) -> tarfile.TarInfo | None:
    parts = PurePosixPath(info.name).parts
    name = parts[-1] if parts else ""
    if any(part in EXCLUDED_NAMES for part in parts):
        return None
    if name.startswith("._") or name == ".DS_Store":
        return None
    if name.endswith((".pyc", ".pyo")):
        return None
    return info


def command_output(*args: str) -> str:
    try:
        result = subprocess.run(
            args,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        return result.stdout
    except (OSError, subprocess.CalledProcessError) as error:
        return f"No disponible: {error}\n"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def add_database(archive: tarfile.TarFile, copy: Path) -> None:
    original = DATABASE.stat()

    def metadata(info: tarfile.TarInfo) -> tarfile.TarInfo:
        info.uid = original.st_uid
        info.gid = original.st_gid
        info.mode = original.st_mode & 0o7777
        info.mtime = original.st_mtime
        return info

    archive.add(
        copy,
        arcname="var/lib/alertar/alertar.db",
        recursive=False,
        filter=metadata,
    )


def main() -> None:
    if os.geteuid() != 0:
        raise SystemExit("Ejecutar con sudo para leer código, claves y base de datos.")
    if not DATABASE.is_file():
        raise SystemExit(f"No existe la base activa: {DATABASE}")

    BACKUPS.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    destination = BACKUPS / f"alertar_full_{stamp}.tar.gz"

    with tempfile.TemporaryDirectory(prefix="alertar-backup-") as temporary:
        temp = Path(temporary)
        database_copy = temp / "alertar.db"
        metadata = temp / "metadata"
        metadata.mkdir()

        with sqlite3.connect(DATABASE) as source, sqlite3.connect(database_copy) as target:
            source.backup(target)
        with sqlite3.connect(database_copy) as check:
            result = check.execute("PRAGMA integrity_check").fetchone()[0]
            if result != "ok":
                raise RuntimeError(f"La copia SQLite no superó integrity_check: {result}")

        runtime_python = Path("/opt/alertar/venv/bin/python")
        (metadata / "pip-freeze.txt").write_text(
            command_output(str(runtime_python), "-m", "pip", "freeze"),
            encoding="utf-8",
        )
        (metadata / "service-status.txt").write_text(
            command_output(
                "systemctl",
                "show",
                "alertar-api",
                "-p",
                "ExecStart,User,Group,WorkingDirectory,EnvironmentFiles,FragmentPath,DropInPaths,UnitFileState",
            ),
            encoding="utf-8",
        )
        (metadata / "system.txt").write_text(
            command_output("uname", "-a")
            + "\n"
            + command_output("tailscale", "version"),
            encoding="utf-8",
        )
        (metadata / "backup-info.json").write_text(
            json.dumps(
                {
                    "created_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
                    "hostname": socket.gethostname(),
                    "database_source": str(DATABASE),
                    "excluded": sorted(EXCLUDED_NAMES)
                    + ["._*", ".DS_Store", "*.pyc", "*.pyo"],
                },
                indent=2,
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )

        with tarfile.open(destination, "w:gz", compresslevel=9) as archive:
            for source in SOURCES:
                if source.exists():
                    archive.add(
                        source,
                        arcname=str(source.relative_to("/")),
                        recursive=True,
                        filter=excluded,
                    )
            add_database(archive, database_copy)
            archive.add(metadata, arcname="backup-metadata", recursive=True)

    os.chmod(destination, 0o600)

    with tarfile.open(destination, "r:gz") as archive:
        members = archive.getmembers()
        for member in members:
            if member.isfile():
                extracted = archive.extractfile(member)
                if extracted is not None:
                    for _ in iter(lambda: extracted.read(1024 * 1024), b""):
                        pass

    print(
        json.dumps(
            {
                "backup": str(destination),
                "bytes": destination.stat().st_size,
                "files_and_directories": len(members),
                "sha256": sha256(destination),
                "contains_secrets": True,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
