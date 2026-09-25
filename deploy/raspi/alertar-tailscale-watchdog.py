#!/usr/bin/env python3
"""Watchdog conservador para recuperar tailscaled sin crear bucles de reinicio."""

import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

STATE_DIR = Path(os.environ.get(
    "ALERTAR_TAILSCALE_WATCHDOG_STATE_DIR",
    "/var/lib/alertar-tailscale-watchdog",
))
STATE_FILE = STATE_DIR / "state.json"
LOCAL_HEALTH_URL = os.environ.get(
    "ALERTAR_LOCAL_HEALTH_URL",
    "http://127.0.0.1:8000/health",
)
FAILURES_REQUIRED = int(os.environ.get("ALERTAR_WATCHDOG_FAILURES", "3"))
COOLDOWN_SECONDS = int(os.environ.get("ALERTAR_WATCHDOG_COOLDOWN", "900"))
POST_RESTART_WAIT_SECONDS = int(os.environ.get("ALERTAR_WATCHDOG_RESTART_WAIT", "8"))
HEALTH_MARKERS = ("network map", "coordination server")


def emit(level, event, **fields):
    print(json.dumps({"level": level, "event": event, **fields}, sort_keys=True), flush=True)


def command(args, timeout=15):
    return subprocess.run(
        args,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def local_api_healthy():
    try:
        with urllib.request.urlopen(LOCAL_HEALTH_URL, timeout=4) as response:
            if response.status != 200:
                return False
            data = json.load(response)
            modern_health = data.get("estado") == "ok" and data.get("base_datos") == "ok"
            legacy_health = data.get("ok") is True and data.get("service") == "alertar-api"
            return modern_health or legacy_health
    except Exception as error:
        emit("warning", "local_api_unhealthy", error=type(error).__name__)
        return False


def tailscale_health():
    try:
        result = command(["tailscale", "status", "--json"])
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, "status_command_" + type(error).__name__
    if result.returncode != 0:
        return False, "status_exit_" + str(result.returncode)
    try:
        status = json.loads(result.stdout)
    except (TypeError, json.JSONDecodeError):
        return False, "status_invalid_json"
    backend = str(status.get("BackendState", "unknown"))
    if backend.lower() != "running":
        return False, "backend_" + backend
    messages = status.get("Health") or []
    if isinstance(messages, str):
        messages = [messages]
    relevant = [
        str(message) for message in messages
        if any(marker in str(message).lower() for marker in HEALTH_MARKERS)
    ]
    if relevant:
        return False, "coordination_health_warning"
    return True, "healthy"


def load_state():
    try:
        data = json.loads(STATE_FILE.read_text())
        return {
            "failures": max(0, int(data.get("failures", 0))),
            "last_restart": max(0, int(data.get("last_restart", 0))),
        }
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return {"failures": 0, "last_restart": 0}


def save_state(state):
    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = STATE_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, sort_keys=True) + "\n")
    temporary.chmod(0o600)
    os.replace(temporary, STATE_FILE)


def restart_tailscale():
    try:
        result = command(["systemctl", "restart", "tailscaled"], timeout=30)
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, "restart_" + type(error).__name__
    if result.returncode != 0:
        return False, "restart_exit_" + str(result.returncode)
    time.sleep(POST_RESTART_WAIT_SECONDS)
    healthy, reason = tailscale_health()
    if not healthy:
        return False, "post_restart_" + reason
    try:
        funnel = command(["tailscale", "funnel", "status"], timeout=15)
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, "funnel_" + type(error).__name__
    if funnel.returncode != 0:
        return False, "funnel_exit_" + str(funnel.returncode)
    return True, "recovered"


def main():
    now = int(time.time())
    state = load_state()
    if not local_api_healthy():
        state["failures"] = 0
        save_state(state)
        emit("warning", "check_skipped", reason="local_api_unhealthy")
        return 0

    healthy, reason = tailscale_health()
    if healthy:
        if state["failures"]:
            emit("info", "tailscale_recovered_without_restart", previous_failures=state["failures"])
        state["failures"] = 0
        save_state(state)
        return 0

    state["failures"] += 1
    emit("warning", "tailscale_unhealthy", reason=reason, failures=state["failures"])
    if state["failures"] < FAILURES_REQUIRED:
        save_state(state)
        return 0

    cooldown_remaining = COOLDOWN_SECONDS - (now - state["last_restart"])
    if cooldown_remaining > 0:
        save_state(state)
        emit("warning", "restart_suppressed", cooldown_remaining_s=cooldown_remaining)
        return 0

    # Persistir antes de reiniciar evita un bucle incluso si systemctl se bloquea o falla.
    state["failures"] = 0
    state["last_restart"] = now
    save_state(state)
    emit("warning", "restarting_tailscaled", trigger=reason)
    recovered, result = restart_tailscale()
    emit("info" if recovered else "error", "restart_result", result=result)
    return 0 if recovered else 1


if __name__ == "__main__":
    sys.exit(main())
