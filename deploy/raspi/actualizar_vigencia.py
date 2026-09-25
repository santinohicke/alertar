"""Despliega el umbral de vigencia del panel sin tocar datos ni credenciales."""
import datetime
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess


ROOT = Path(__file__).resolve().parents[2]
PACKAGE = Path("/opt/alertar/api/alertar_web")
PROJECT = Path("/home/agusttin/Ciudad_Inteligente")
FILES = {
    ROOT / "backend/app.py": PACKAGE / "app.py",
    ROOT / "backend/panel.py": PACKAGE / "panel.py",
    ROOT / "backend/static/panel.js": PACKAGE / "static/panel.js",
}


def run(*args):
    subprocess.run(args, check=True)


def main():
    if os.geteuid() != 0:
        raise SystemExit("Requiere sudo.")
    for source, destination in FILES.items():
        if not source.is_file() or not destination.is_file():
            raise SystemExit(f"Falta archivo requerido: {source} o {destination}")
    if "STALE_SECONDS=60" not in (ROOT / "backend/app.py").read_text():
        raise SystemExit("El paquete no contiene el umbral esperado de 60 segundos.")

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = PROJECT / "backups" / ("antes_vigencia_" + stamp)
    backup.mkdir(parents=True, mode=0o700)
    backup.chmod(0o700)
    for destination in FILES.values():
        saved = backup / destination.relative_to(PACKAGE)
        saved.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(destination, saved)

    service = pwd.getpwnam("alertar")
    try:
        for source, destination in FILES.items():
            shutil.copy2(source, destination)
            os.chown(destination, service.pw_uid, service.pw_gid)
            destination.chmod(0o640)
        run("systemctl", "restart", "alertar-api")
        run("systemctl", "is-active", "--quiet", "alertar-api")
    except Exception:
        for destination in FILES.values():
            saved = backup / destination.relative_to(PACKAGE)
            shutil.copy2(saved, destination)
            os.chown(destination, service.pw_uid, service.pw_gid)
        run("systemctl", "restart", "alertar-api")
        raise SystemExit(f"Falló el despliegue; se restauró {backup}")

    print(json.dumps({"actualizado": True, "vigencia_s": 60,
                      "respaldo": str(backup), "servicio": "activo"}))


if __name__ == "__main__":
    main()
