import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import rust_server as server


class RuntimeTests(unittest.TestCase):
    def test_secret_redaction_and_validation(self):
        secret = 'test-secret-with-"quotes-and/%'
        for form in (secret, json.dumps(secret)[1:-1], server.quote(secret, safe="")):
            self.assertEqual(server.redact(form, secret), "[redacted]")
        with patch.dict(os.environ, {"RCON_PASSWORD": "short", "RCON_PASSWORD_FILE": ""}):
            with self.assertRaises(server.Error):
                server.password()

    def test_data_lock_excludes_second_process(self):
        with tempfile.TemporaryDirectory() as directory:
            with server.locked(Path(directory)):
                code = "from pathlib import Path; from rust_server import locked; locked(Path(%r)).__enter__()" % directory
                process = subprocess.run([sys.executable, "-c", code], capture_output=True)
                self.assertNotEqual(process.returncode, 0)
                self.assertIn(b"holds the data lock", process.stderr)

    def test_configuration_preserves_operator_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rust/server/homelab/cfg/server.cfg"
            path.parent.mkdir(parents=True)
            path.write_text('server.hostname "Mine"\n')
            with patch.dict(os.environ, {"SERVER_IDENTITY": "homelab", "SERVER_CONFIG": ""}):
                self.assertEqual(server.configure(Path(directory)), "homelab")
            self.assertEqual(path.read_text(), 'server.hostname "Mine"\n')

    def test_identity_cannot_escape_data_directory(self):
        with patch.dict(os.environ, {"SERVER_IDENTITY": "../escape"}):
            with self.assertRaises(server.Error):
                server.configure(Path("/tmp"))

    def test_explicit_config_mount_replaces_existing_config(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            source = data / "mounted-server.cfg"
            source.write_text('server.hostname "GitOps"\n')
            config = data / "rust/server/homelab/cfg/server.cfg"
            config.parent.mkdir(parents=True)
            config.write_text('server.hostname "Old"\n')
            with patch.dict(os.environ, {"SERVER_IDENTITY": "homelab", "SERVER_CONFIG": str(source)}):
                server.configure(data)
                server.configure(data)
            self.assertTrue(config.is_symlink())
            self.assertEqual(config.read_text(), source.read_text())

    def test_interrupted_install_cannot_launch_partial_game(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            (data / ".rust-server-installing").touch()
            with patch.object(server, "password", return_value="test-secret-value"):
                with self.assertRaisesRegex(server.Error, "interrupted"):
                    server.run(data)

    def test_rcon_errors_do_not_include_credentials(self):
        secret = "test-secret-value"
        with patch.object(server, "create_connection", side_effect=OSError("ws://" + secret)):
            with self.assertRaises(server.Error) as result:
                server.rcon("status", secret)
            self.assertNotIn(secret, str(result.exception))

    def test_rcon_has_total_deadline_despite_broadcasts(self):
        class Connection:
            def send(self, _): pass
            def settimeout(self, _): pass
            def close(self): pass
            def recv(self): return '{"Identifier": -1, "Message": "log"}'
        with patch.object(server, "create_connection", return_value=Connection()):
            start = time.monotonic()
            with self.assertRaises(server.Error):
                server.rcon("serverinfo", "test-secret-value", timeout=0.02)
            self.assertLess(time.monotonic() - start, 0.5)

    def test_shutdown_saves_then_quits(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "ready"
            commands = []
            def rcon(command, *_args, **_kwargs):
                commands.append(command)
                if command == "quit":
                    marker.unlink()
            def signal_when_ready():
                while not marker.exists():
                    time.sleep(0.01)
                os.kill(os.getpid(), signal.SIGTERM)
            thread = threading.Thread(target=signal_when_ready, daemon=True)
            thread.start()
            code = "from pathlib import Path; import time; p=Path(%r); p.touch(); exec('while p.exists(): time.sleep(.01)')" % str(marker)
            with patch.object(server, "rcon", side_effect=rcon):
                status = server.supervise([sys.executable, "-c", code], directory, game=True)
            thread.join(timeout=1)
            self.assertEqual(status, 0)
            self.assertEqual(commands, ["server.save", "quit"])

    def test_unresponsive_game_is_killed_after_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "ready"
            def signal_when_ready():
                while not marker.exists():
                    time.sleep(0.01)
                os.kill(os.getpid(), signal.SIGTERM)
            thread = threading.Thread(target=signal_when_ready, daemon=True)
            thread.start()
            code = ("from pathlib import Path; import signal,time; "
                    "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                    "Path(%r).touch(); time.sleep(30)") % str(marker)
            with patch.object(server, "rcon", side_effect=server.Error("unavailable")):
                status = server.supervise([sys.executable, "-c", code], directory,
                                          game=True, stop_timeout=0.2)
            thread.join(timeout=1)
            self.assertEqual(status, 137)


if __name__ == "__main__":
    unittest.main()
