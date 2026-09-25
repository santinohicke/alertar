#!/usr/bin/env python3
"""Instala el watchdog de Tailscale sin modificar credenciales ni la API."""

import datetime
import json
import os
import shutil
import subprocess
from pathlib import Path

SOURCE = Path(__file__).resolve().parent
SCRIPT = Path("/usr/local/libexec/alertar-tailscale-watchdog.py")
SERVICE = Path("/etc/systemd/system/alertar-tailscale-watchdog.service")
TIMER = Path("/etc/systemd/system/alertar-tailscale-watchdog.timer")
STATE_DIR = Path("/var/lib/alertar-tailscale-watchdog")
BACKUP_ROOT = Path("/home/agusttin/Ciudad_Inteligente/backups")


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True)


def main():
    if os.geteuid() != 0:
        raise SystemExit("Requiere sudo; no ingresar contraseñas en el chat.")

    sources = {
        SCRIPT: SOURCE / SCRIPT.name,
        SERVICE: SOURCE / SERVICE.name,
        TIMER: SOURCE / TIMER.name,
    }
    for source in sources.values():
        if not source.is_file():
            raise SystemExit("Falta archivo de instalación: " + str(source))
    compile((SOURCE / SCRIPT.name).read_text(), str(SOURCE / SCRIPT.name), "exec")
    run("systemd-analyze", "verify", str(SOURCE / SERVICE.name), str(SOURCE / TIMER.name))

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = BACKUP_ROOT / ("antes_watchdog_tailscale_" + stamp)
    backup.mkdir(parents=True, mode=0o700)
    backup.chmod(0o700)
    existing = {}
    for destination in sources:
        if destination.exists():
            saved = backup / destination.name
            shutil.copy2(destination, saved)
            existing[destination] = saved

    try:
        SCRIPT.parent.mkdir(parents=True, exist_ok=True)
        STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
        STATE_DIR.chmod(0o700)
        for destination, source in sources.items():
            shutil.copy2(source, destination)
            destination.chmod(0o755 if destination == SCRIPT else 0o644)
            os.chown(destination, 0, 0)
        os.chown(STATE_DIR, 0, 0)
        run("systemctl", "daemon-reload")
        run("systemctl", "enable", "--now", TIMER.name)
        # Primera ejecución no reinicia: solo inicializa estado y confirma permisos.
        run("systemctl", "start", SERVICE.name)
        enabled = run("systemctl", "is-enabled", TIMER.name).stdout.strip()
        active = run("systemctl", "is-active", TIMER.name).stdout.strip()
    except Exception:
        subprocess.run(["systemctl", "disable", "--now", TIMER.name], check=False)
        for destination in sources:
            if destination in existing:
                shutil.copy2(existing[destination], destination)
            elif destination.exists():
                destination.unlink()
        subprocess.run(["systemctl", "daemon-reload"], check=False)
        raise

    print(json.dumps({
        "instalado": True,
        "timer": active,
        "habilitado": enabled,
        "respaldo": str(backup),
        "estado": str(STATE_DIR / "state.json"),
    }, sort_keys=True))


if __name__ == "__main__":
    main()
