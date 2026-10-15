"""Small Rust lifecycle wrapper; persistent game files are owned by SteamCMD."""

import argparse
from contextlib import closing, contextmanager
from dataclasses import asdict
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from urllib.parse import quote

import a2s
from websocket import create_connection, WebSocketConnectionClosedException


class Error(Exception):
    """An actionable message which contains no credentials."""


def password():
    source = os.environ.get("RCON_PASSWORD_FILE")
    value = Path(source).read_text().strip() if source else os.environ.get("RCON_PASSWORD", "")
    if len(value) < 16 or any(ord(c) < 33 or ord(c) > 126 for c in value):
        raise Error("Set RCON_PASSWORD_FILE or RCON_PASSWORD to at least 16 printable, non-space characters")
    return value


def redact(text, secret):
    if not secret:
        return text
    for value in (secret, json.dumps(secret)[1:-1], quote(secret, safe="")):
        text = text.replace(value, "[redacted]")
    return text


def rcon(command, secret, timeout=10):
    deadline = time.monotonic() + timeout
    port = int(os.environ.get("RCON_PORT", "28016"))
    try:
        with closing(create_connection("ws://127.0.0.1:%d/%s" % (port, quote(secret, safe="")),
                                       timeout=timeout, http_no_proxy=["127.0.0.1"])) as connection:
            connection.send(json.dumps(dict(Identifier=1, Message=command, Name="rust-server")))
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError()
                connection.settimeout(remaining)
                response = connection.recv()
                if not response:
                    raise WebSocketConnectionClosedException()
                message = json.loads(response)
                if message.get("Identifier") == 1:
                    return redact(message.get("Message", ""), secret)
    except WebSocketConnectionClosedException:
        if command == "quit":
            return "Shutdown requested"
        raise Error("RCON closed before responding") from None
    except Exception as error:
        raise Error("Local RCON failed (%s)" % type(error).__name__) from None


@contextmanager
def locked(data):
    data.mkdir(parents=True, exist_ok=True)
    with (data / ".rust-server.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Error("Another server or installer holds the data lock; stop it before maintenance") from None
        yield


def supervise(arguments, cwd, secret="", game=False, stop_timeout=90):
    stopping = threading.Event()
    previous = {}
    for sig in (signal.SIGTERM, signal.SIGINT):
        previous[sig] = signal.signal(sig, lambda *_: stopping.set())
    environment = dict(os.environ)
    environment.pop("RCON_PASSWORD", None)
    process = None
    def send_group(sig):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass

    try:
        process = subprocess.Popen(arguments, cwd=cwd, env=environment,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   text=True, errors="replace", bufsize=1,
                                   start_new_session=True)

        def output():
            for line in process.stdout:
                print(redact(line, secret), end="", flush=True)

        reader = threading.Thread(target=output, daemon=True)
        reader.start()
        deadline = None
        forced = False
        while process.poll() is None:
            if stopping.is_set() and deadline is None:
                deadline = time.monotonic() + stop_timeout
                if game:
                    print("Shutdown requested; saving the world and quitting", flush=True)
                    try:
                        rcon("server.save", secret, timeout=min(15, stop_timeout / 3))
                        rcon("quit", secret, timeout=min(10, stop_timeout / 3))
                    except Error as error:
                        print(str(error) + "; sending SIGTERM", flush=True)
                        send_group(signal.SIGTERM)
                else:
                    send_group(signal.SIGTERM)
            if deadline is not None and time.monotonic() >= deadline and not forced:
                print("Shutdown deadline exceeded; sending SIGKILL", flush=True)
                send_group(signal.SIGKILL)
                forced = True
            time.sleep(0.1)
        reader.join(timeout=3)
        return 128 - process.returncode if process.returncode < 0 else process.returncode
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        if process is not None:
            if process.returncode is None:
                send_group(signal.SIGKILL)
                process.wait()
            process.stdout.close()


def install(data, validate=False):
    steam = data / "steamcmd"
    game = data / "rust"
    home = data / "home"
    for path in (steam, game, home):
        path.mkdir(parents=True, exist_ok=True)
    os.environ["HOME"] = str(home)
    if not (steam / "steamcmd.sh").exists():
        shutil.copytree("/opt/steamcmd", steam, dirs_exist_ok=True)
    marker = data / ".rust-server-installing"
    marker.touch()
    update = ["+app_update", "258550"] + (["validate"] if validate else [])
    status = supervise([str(steam / "steamcmd.sh"), "+force_install_dir", str(game),
                        "+login", "anonymous"] + update + ["+quit"], steam)
    if status != 0 or not (game / "RustDedicated").is_file():
        raise Error("SteamCMD installation failed (exit %d); retry install or update" % status)
    sdk = home / ".steam/sdk64"
    sdk.mkdir(parents=True, exist_ok=True)
    link = sdk / "steamclient.so"
    link.unlink(missing_ok=True)
    link.symlink_to(steam / "linux64/steamclient.so")
    marker.unlink()


def configure(data):
    identity = os.environ.get("SERVER_IDENTITY", "homelab")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", identity):
        raise Error("SERVER_IDENTITY must contain 1-64 letters, numbers, underscores or hyphens")
    config = data / "rust/server" / identity / "cfg/server.cfg"
    config.parent.mkdir(parents=True, exist_ok=True)
    source = os.environ.get("SERVER_CONFIG")
    if source:
        target = Path(source).resolve(strict=True)
        if config.resolve() != target:
            config.unlink(missing_ok=True)
            config.symlink_to(target)
    elif not config.exists():
        config.unlink(missing_ok=True)
        shutil.copyfile("/opt/rust/server.cfg", config)
    return identity


def run(data):
    secret = password()  # Fail before a multi-GB install when credentials are missing.
    if (data / ".rust-server-installing").exists():
        raise Error("The previous installation/update was interrupted; run validate before starting")
    if not (data / "rust/RustDedicated").is_file():
        install(data, validate=True)
    os.environ["HOME"] = str(data / "home")
    identity = configure(data)
    timeout = int(os.environ.get("STOP_TIMEOUT", "90"))
    if timeout < 10 or timeout > 600:
        raise Error("STOP_TIMEOUT must be between 10 and 600 seconds")
    return supervise(["./RustDedicated", "-batchmode", "-nographics", "-logfile", "/dev/stdout",
                      "+server.identity", identity, "+server.ip", "0.0.0.0",
                      "+server.port", os.environ.get("SERVER_PORT", "28015"),
                      "+server.queryport", os.environ.get("QUERY_PORT", "28017"),
                      "+rcon.ip", "127.0.0.1", "+rcon.port", os.environ.get("RCON_PORT", "28016"),
                      "+rcon.web", "1", "+rcon.password", secret],
                     data / "rust", secret=secret, game=True, stop_timeout=timeout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", nargs="?", default="run",
                        choices=["run", "install", "update", "validate", "probe", "rcon", "stop"])
    parser.add_argument("command", nargs="*")
    args = parser.parse_args()
    os.umask(0o007)
    if args.action == "probe":
        try:
            info = a2s.info(("127.0.0.1", int(os.environ.get("QUERY_PORT", "28017"))), timeout=3)
        except Exception as error:
            raise Error("A2S query failed (%s)" % type(error).__name__) from None
        print(json.dumps(asdict(info)))
        return 0
    if args.action in ("rcon", "stop"):
        secret = password()
        commands = ["server.save", "quit"] if args.action == "stop" else [" ".join(args.command)]
        if not commands[0]:
            raise Error("Supply an RCON command")
        for command in commands:
            print(rcon(command, secret))
        return 0
    if args.command:
        raise Error("Unexpected arguments; configure the game through server.cfg")
    data = Path(os.environ.get("DATA_DIR", "/data")).resolve()
    with locked(data):
        if args.action == "run":
            return run(data)
        if (args.action != "install" or not (data / "rust/RustDedicated").exists()
                or (data / ".rust-server-installing").exists()):
            install(data, validate=args.action != "update")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Error as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        # Exception strings from WebSockets/OS calls may contain credentials.
        print("rust-server failed (%s)" % type(error).__name__, file=sys.stderr)
        sys.exit(1)
