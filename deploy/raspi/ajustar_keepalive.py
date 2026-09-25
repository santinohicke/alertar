"""Aplicar con sudo: conserva el drop-in y cambia solo el plazo keep-alive.
Reinicia brevemente la API. No modifica la base, credenciales ni Funnel.
"""
from datetime import datetime, timezone
import os
from pathlib import Path
import shutil
import subprocess


def main():
    if os.geteuid() != 0:
        raise SystemExit("Ejecutar con sudo en la Raspberry.")
    config = Path('/etc/systemd/system/alertar-api.service.d/40-alertar-panel.conf')
    original = config.read_text()
    old, new = '--timeout-keep-alive 3 ', '--timeout-keep-alive 30 '
    if old not in original:
        if new in original:
            print('El archivo ya configura 30 s; no se modificó ni reinició el servicio.')
            return
        raise SystemExit('Configuración diferente de la esperada; no se modificó nada.')
    if original.count(old) != 1:
        raise SystemExit('Configuración ambigua; no se modificó nada.')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = Path('/home/agusttin/Ciudad_Inteligente/backups') / ('keepalive_' + stamp)
    backup.mkdir(parents=True, mode=0o700)
    saved = backup / config.name
    shutil.copy2(config, saved)
    try:
        config.write_text(original.replace(old, new))
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        subprocess.run(['systemctl', 'restart', 'alertar-api'], check=True)
    except Exception:
        shutil.copy2(saved, config)
        subprocess.run(['systemctl', 'daemon-reload'], check=False)
        subprocess.run(['systemctl', 'restart', 'alertar-api'], check=False)
        raise
    print('Keep-alive ajustado a 30 s. API reiniciada. Respaldo:', saved)
    print('Validación funcional pendiente a cargo del usuario.')


if __name__ == '__main__':
    main()
