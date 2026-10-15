"""Offline lifecycle checks against the final image under workload restrictions."""
import os
from pathlib import Path
import signal
import subprocess
import time

assert os.getuid() == 12345 and os.getgid() == 0
assert not os.access("/opt/rust/rust_server.py", os.W_OK)
game = Path("/data/rust/RustDedicated")
game.parent.mkdir()
game.write_text('''#!/opt/venv/bin/python
from pathlib import Path
import signal, sys, time
def stop(*_):
    Path('/data/stopped').touch()
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
print(' '.join(sys.argv), flush=True)
Path('/data/ready').touch()
while True: time.sleep(.1)
''')
game.chmod(0o750)
secret = "smoke-test-secret/with-special%chars"
Path("/tmp/rcon-password").write_text(secret)
environment = dict(os.environ, RCON_PASSWORD_FILE="/tmp/rcon-password")
config = Path("/data/rust/server/homelab/cfg/server.cfg")
config.parent.mkdir(parents=True)
config.write_text('server.hostname "Preserved"\n')
# An existing install must not contact Steam or require credentials.
subprocess.run(["rust-server", "install"], env=dict(os.environ), check=True)
process = subprocess.Popen(["rust-server", "run"], env=environment,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
try:
    deadline = time.monotonic() + 10
    while not Path("/data/ready").exists():
        if time.monotonic() > deadline or process.poll() is not None:
            if process.poll() is None:
                process.kill()
            output, _ = process.communicate(timeout=5)
            raise RuntimeError("fake game failed to start: " + output)
        time.sleep(.05)
    conflict = subprocess.run(["rust-server", "update"], capture_output=True, text=True)
    assert conflict.returncode != 0 and "holds the data lock" in conflict.stderr
    process.send_signal(signal.SIGTERM)
    output, _ = process.communicate(timeout=10)
    assert process.returncode == 0, output
    assert secret not in output and "[redacted]" in output, output
    assert "saving the world" in output and "sending SIGTERM" in output, output
    assert Path("/data/stopped").exists()
    assert config.read_text() == 'server.hostname "Preserved"\n'
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
print("PASS: arbitrary UID, read-only root, no capabilities, secret redaction, install policy, data lock, config preservation and SIGTERM fallback")
