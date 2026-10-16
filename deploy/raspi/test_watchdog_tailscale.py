import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).with_name("alertar-tailscale-watchdog.py")
SPEC = importlib.util.spec_from_file_location("alertar_tailscale_watchdog", MODULE_PATH)
watchdog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(watchdog)


class Result:
    def __init__(self, returncode=0, stdout=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = ""


class WatchdogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        watchdog.STATE_DIR = Path(self.temp.name)
        watchdog.STATE_FILE = watchdog.STATE_DIR / "state.json"
        watchdog.FAILURES_REQUIRED = 3
        watchdog.COOLDOWN_SECONDS = 900
        watchdog.POST_RESTART_WAIT_SECONDS = 0

    def tearDown(self):
        self.temp.cleanup()

    def status(self, health=None, backend="Running"):
        return Result(stdout=json.dumps({"BackendState": backend, "Health": health}))

    def test_accepts_legacy_api_health_contract(self):
        response = mock.MagicMock()
        response.status = 200
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        with mock.patch.object(watchdog.urllib.request, "urlopen", return_value=response), \
             mock.patch.object(watchdog.json, "load", return_value={"ok": True, "service": "alertar-api"}):
            self.assertTrue(watchdog.local_api_healthy())

    def test_coordination_warning_is_unhealthy(self):
        with mock.patch.object(watchdog, "command", return_value=self.status([
            "Unable to connect to the Tailscale coordination server"
        ])):
            self.assertEqual(watchdog.tailscale_health(), (False, "coordination_health_warning"))

    def test_unrelated_health_warning_is_not_restarted(self):
        with mock.patch.object(watchdog, "command", return_value=self.status([
            "A newer client version is available"
        ])):
            self.assertEqual(watchdog.tailscale_health(), (True, "healthy"))

    @mock.patch.object(watchdog, "local_api_healthy", return_value=True)
    def test_three_failures_trigger_one_restart(self, _api):
        with mock.patch.object(watchdog, "tailscale_health", return_value=(False, "coordination_health_warning")), \
             mock.patch.object(watchdog, "restart_tailscale", return_value=(True, "recovered")) as restart, \
             mock.patch.object(watchdog.time, "time", return_value=2000):
            self.assertEqual(watchdog.main(), 0)
            self.assertEqual(watchdog.main(), 0)
            self.assertEqual(watchdog.main(), 0)
        restart.assert_called_once_with()

    @mock.patch.object(watchdog, "local_api_healthy", return_value=True)
    def test_cooldown_prevents_restart_loop(self, _api):
        watchdog.save_state({"failures": 2, "last_restart": 1900})
        with mock.patch.object(watchdog, "tailscale_health", return_value=(False, "coordination_health_warning")), \
             mock.patch.object(watchdog, "restart_tailscale") as restart, \
             mock.patch.object(watchdog.time, "time", return_value=2000):
            self.assertEqual(watchdog.main(), 0)
        restart.assert_not_called()

    @mock.patch.object(watchdog, "local_api_healthy", return_value=False)
    def test_local_api_failure_never_restarts_tailscale(self, _api):
        watchdog.save_state({"failures": 2, "last_restart": 0})
        with mock.patch.object(watchdog, "restart_tailscale") as restart:
            self.assertEqual(watchdog.main(), 0)
        restart.assert_not_called()
        self.assertEqual(watchdog.load_state()["failures"], 0)


if __name__ == "__main__":
    unittest.main()
