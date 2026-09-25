"""Instalación administrativa explícita. Ejecutar con sudo desde el paquete.
No imprime ni copia la clave principal fuera de /etc. Respaldo antes de cambios.
"""
import datetime
import grp
import json
import os
from pathlib import Path
import pwd
import secrets
import shlex
import shutil
import sqlite3
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
PROJECT = Path("/home/agusttin/Ciudad_Inteligente")
API = Path("/opt/alertar/api")
PYTHON = "/opt/alertar/venv/bin/python"
DROPIN = Path("/etc/systemd/system/alertar-api.service.d/40-alertar-panel.conf")


def envfile(path):
    values = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if sep:
            parsed = shlex.split(value, comments=True)
            values[key.strip()] = parsed[0] if parsed else ""
    return values


def run(*args):
    subprocess.run(args, check=True)


def main():
    if os.geteuid() != 0:
        raise SystemExit("Requiere sudo; no ingresar contraseñas en el chat.")
    if not (API / "app.py").is_file():
        raise SystemExit("No se encontró la API original. No se modificó el servicio.")
    original_env = envfile(Path("/etc/alertar-api.env"))
    key = original_env.get("ALERTAR_API_KEY", "")
    if len(key) < 24:
        raise SystemExit("La clave actual debe tener al menos 24 caracteres; revisar localmente.")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = PROJECT / "backups" / ("antes_panel_" + stamp)
    backup.mkdir(parents=True, mode=0o700)
    backup.chmod(0o700)
    shutil.copy2(API / "app.py", backup / "app.py")
    shutil.copy2("/etc/systemd/system/alertar-api.service", backup / "alertar-api.service")
    for name in ("gateway.py", "alertar_web"):
        src = API / name
        if src.is_dir():
            shutil.copytree(src, backup / name)
        elif src.exists():
            shutil.copy2(src, backup / name)
    had_dropin = DROPIN.exists()
    if had_dropin:
        shutil.copy2(DROPIN, backup / "40-alertar-panel.conf")
    with sqlite3.connect("/var/lib/alertar/alertar.db") as src, sqlite3.connect(backup / "alertar.db") as dst:
        src.backup(dst)
    # Dependencias pequeñas; no actualiza FastAPI/Uvicorn existentes.
    run(PYTHON, "-m", "pip", "install", "--no-cache-dir", "-r", str(ROOT / "deploy/raspi/requirements.txt"))
    user, service = pwd.getpwnam("agusttin"), pwd.getpwnam("alertar")
    device_env = Path("/etc/alertar-device.env")
    if device_env.exists():
        device_key = envfile(device_env).get("ALERTAR_DEVICE_KEY", "")
    else:
        device_key = secrets.token_urlsafe(32)
        descriptor = os.open(device_env, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)
        with os.fdopen(descriptor, "w") as file:
            file.write("ALERTAR_DEVICE_KEY=" + device_key + "\n")
    if len(device_key) < 24 or not all(c.isalnum() or c in "_-" for c in device_key):
        raise SystemExit("Revisar clave exclusiva del dispositivo en /etc; no se inició despliegue.")
    os.chown(device_env, 0, service.pw_gid)
    device_env.chmod(0o640)
    secret_dir = PROJECT / "secrets"
    secret_dir.mkdir(exist_ok=True, mode=0o700)
    os.chown(secret_dir, user.pw_uid, user.pw_gid)
    secret_dir.chmod(0o700)
    key_header = secret_dir / "conectividad_secrets.h"
    descriptor = os.open(key_header, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as file:
        file.write('#pragma once\n#define ALERTAR_DEVICE_KEY "' + device_key + '"\n')
    os.chown(key_header, user.pw_uid, user.pw_gid)
    key_header.chmod(0o600)
    try:
        package = API / "alertar_web"
        package.mkdir(exist_ok=True)
        for name in ("__init__.py", "app.py", "panel.py"):
            shutil.copy2(ROOT / "backend" / name, package / name)
        for name in ("templates", "static"):
            shutil.copytree(ROOT / "backend" / name, package / name, dirs_exist_ok=True)
        shutil.copy2(ROOT / "deploy/raspi/gateway.py", API / "gateway.py")
        # Código legible por el usuario del servicio; no altera /opt/alertar (0700).
        for path in [package, *package.rglob("*"), API / "gateway.py"]:
            os.chown(path, service.pw_uid, service.pw_gid)
            path.chmod(0o750 if path.is_dir() else 0o640)
        DROPIN.parent.mkdir(exist_ok=True)
        shutil.copy2(ROOT / "deploy/raspi/limites.conf", DROPIN)
        DROPIN.chmod(0o644)
        run("systemctl", "daemon-reload")
        run("systemctl", "restart", "alertar-api")
        for attempt in range(15):
            try:
                req = urllib.request.Request("http://127.0.0.1:8000/api/panel/tunel-01", headers={"X-API-Key":key})
                with urllib.request.urlopen(req, timeout=3) as response:
                    assert response.status == 200 and "eventos" in json.load(response)
                break
            except Exception:
                if attempt == 14:
                    raise
                time.sleep(1)
    except Exception:
        # Retirar de forma recuperable el despliegue fallido, conservar la DB viva.
        for name in ("gateway.py", "alertar_web"):
            dest = API / name
            if dest.exists():
                shutil.move(str(dest), str(backup / ("fallido_" + name)))
            saved = backup / name
            if saved.is_dir():
                shutil.copytree(saved, dest)
            elif saved.exists():
                shutil.copy2(saved, dest)
        if DROPIN.exists():
            shutil.move(str(DROPIN), str(backup / "fallido.conf"))
        if had_dropin:
            shutil.copy2(backup / "40-alertar-panel.conf", DROPIN)
        run("systemctl", "daemon-reload")
        run("systemctl", "restart", "alertar-api")
        raise SystemExit("Falló verificación: se restauró configuración anterior. Ver respaldo " + str(backup))
    print(json.dumps({"instalado":True,"respaldo":str(backup),"clave_simulacion_archivo":str(key_header),
                      "panel":"https://raspi.tail5a3b96.ts.net/","api_anterior":"conservada"}))


if __name__ == "__main__":
    main()
