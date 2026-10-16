"""Ejecuta el serializador real del firmware compilado para la PC."""
import json
import subprocess
import unittest
from pathlib import Path

from app import validate


class FirmwareContract(unittest.TestCase):
    def test_native_firmware_matches_api(self):
        binary = Path(__file__).resolve().parents[2] / "verificaciones" / "protocolo_test"
        if not binary.exists():
            self.skipTest("Compilar tests/protocolo_test.cpp según CONECTIVIDAD.md")
        result = subprocess.run([str(binary)], check=True, capture_output=True, text=True)
        events = [validate(json.loads(line)) for line in result.stdout.splitlines()]
        self.assertEqual(len(events), 2)
        self.assertIsNone(events[0]["medido_en"])
        self.assertEqual(events[1]["medido_en"], "2026-01-01T00:00:00+00:00")
