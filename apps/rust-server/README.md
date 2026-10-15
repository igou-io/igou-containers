# Rust dedicated server

`ghcr.io/igou-io/rust-server` runs Facepunch's Linux dedicated server as an
arbitrary UID with GID 0. It needs one writable `/data` volume and writable
`/tmp`; the root filesystem can be read-only. No root entrypoint, ownership
changes, extra capabilities, panel, plugin loader or public RCON listener.
The launcher is maintained here; Facepunch owns the game and its license.

Debian **13 slim** supplies SteamCMD's 32-bit glibc/libstdc++ ABI and the game's
64-bit libraries. The actual October 2026 game download requires `GLIBC_2.35`
in `UnityPlayer.so`; UBI 9 has glibc 2.34 and failed the real startup test.
UBI 10 removed the 32-bit packages needed by SteamCMD. Python runs the lifecycle
wrapper; hash-pinned `python-a2s` and `websocket-client` handle the protocols.
Only `linux/amd64` is supported. Base digests and Python requirements are tracked
by Renovate. Valve's unversioned SteamCMD bootstrap is SHA-256 pinned; replacing
that archive requires a reviewed checksum change.

Game files are **not included in the image**. SteamCMD downloads app **258550**
anonymously into `/data/rust` on first run. The writable SteamCMD copy and home
live in `/data/steamcmd` and `/data/home`. Image version and game build are
independent; record both when diagnosing a problem. Game updates come from
Steam, outside the image's dependency scanning and digest pinning.

## Run

Reserve roughly 4 CPUs, 12 GiB RAM and 50 GiB of SSD-backed persistent storage
for the default small map; actual requirements grow with map size and players.
The volume must permit the assigned UID to write through GID 0. Kubernetes
should set `fsGroup` according to its storage/SCC policy. The data volume must
allow execution of the installed game and SteamCMD.

Create a secret file outside the checkout; use a random password of at least
16 printable non-space characters (64 hex characters recommended). Mount it
read-only and keep its contents out of arguments to the container engine:

```bash
podman volume create rust-data
podman run -d --name rust --read-only \
  --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,size=1g \
  -v rust-data:/data \
  -v /absolute/path/to/secret-directory:/run/rcon:ro,Z \
  -e RCON_PASSWORD_FILE=/run/rcon/rcon-password \
  ghcr.io/igou-io/rust-server:latest
```

This publishes no host ports. Gameplay is UDP/28015, A2S query is UDP/28017;
create an internal Kubernetes ClusterIP Service for those ports. RCON listens
on **127.0.0.1:28016** inside the container. Use `exec` to administer it:

```bash
podman exec rust rust-server probe
podman exec rust rust-server rcon serverinfo
podman exec rust rust-server rcon server.save
podman stop --time 120 rust
```

SIGTERM/SIGINT asks WebRCON to save, then quit. If RCON is unavailable during
startup, the launcher sends SIGTERM to the game's process group. A bounded
deadline ends a stuck process with SIGKILL; forced termination cannot guarantee
a final save. Use a container/Kubernetes termination grace of **at least 120
seconds** for the default 90-second `STOP_TIMEOUT`. Tini runs as PID 1
and reaps adopted Steam/crash-handler processes. A data-volume lock prevents
another launcher or maintenance process from modifying a running installation.
The tested game build exits with status 137 even after a successful WebRCON
`quit` without an engine stop signal. The launcher preserves that native exit
status; use save/shutdown logs and a restored world to verify completion.

The password is read from `RCON_PASSWORD_FILE`, or optionally `RCON_PASSWORD`.
It is removed from the child's environment and filtered from captured game
output and RCON replies. Rust requires it on the game's process arguments, so
process inspection within the same PID namespace can see it. Restrict pod exec
access. RCON commands can change server state; treat them as administrator access.

## Configuration and updates

The first run seeds `server/<identity>/cfg/server.cfg` under `/data/rust`.
Subsequent starts preserve it, including bans, owners and other identity files.
Defaults: identity `homelab`, procedural map size 3000, seed 12345, ten players,
five-minute saves, and Rust+ disabled. Edit the persistent config while stopped,
or set `SERVER_CONFIG` to a mounted config file; that explicit override replaces
`server.cfg` with a symlink on each start. Keep credentials out of server.cfg.

Environment settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `RCON_PASSWORD_FILE` | unset | Mounted secret file; preferred over environment |
| `RCON_PASSWORD` | unset | Alternative credential source |
| `SERVER_IDENTITY` | `homelab` | Persistent world identity; letters/digits/`_`/`-` |
| `SERVER_CONFIG` | unset | Explicit mounted server.cfg override |
| `SERVER_PORT` | `28015` | Gameplay UDP port |
| `QUERY_PORT` | `28017` | A2S UDP port, also used by `probe` |
| `RCON_PORT` | `28016` | Loopback WebRCON port |
| `STOP_TIMEOUT` | `90` | Graceful shutdown deadline, 10–600 seconds |
| `DATA_DIR` | `/data` | Installation, save and lock directory |

`run` installs with validation only if `RustDedicated` is absent. Existing
installations start without a network update or full validation. `install` is
idempotent; `update` explicitly downloads the current stable game, and `validate`
also checks/repairs installed files. Stop the server and back up the identity
directory before updating. An image upgrade alone does not update Rust.
An interrupted install/update leaves a marker and blocks startup until an
explicit `validate` repairs the installation.
Facepunch releases can require world wipes or a matching client update; the
launcher does not wipe saves automatically or promise backwards compatibility.

```bash
podman stop --time 120 rust
podman run --rm --read-only --tmpfs /tmp:rw \
  --cap-drop ALL --security-opt no-new-privileges \
  -v rust-data:/data ghcr.io/igou-io/rust-server:latest update
podman start rust
```

For OpenShift use one Deployment with `Recreate`, one RWO PVC, `runAsNonRoot`,
`allowPrivilegeEscalation: false`, all capabilities dropped, a read-only root,
and an `emptyDir` for `/tmp`. Run `rust-server probe` as readiness/startup probes.
Allow enough startup time for the initial Steam download and map generation;
do not use a short liveness probe that repeatedly kills that work. No privileged
SCC or fixed `runAsUser` is needed. The existing `/data/rust` layout and `homelab`
identity match the initial `igou-openshift` deployment.

## Build and verify

```bash
podman build -t localhost/rust-server:dev \
  -f apps/rust-server/Containerfile apps/rust-server
CONTAINER_ENGINE=podman bash apps/rust-server/smoke-test.sh localhost/rust-server:dev
```

Unit tests run in the build stage. The offline smoke test uses UID 12345 (absent
from `/etc/passwd`), GID 0, no network, a read-only root, no capabilities and only
tmpfs writable storage. It checks install policy, config preservation, data
locking, redaction and signal fallback using a fake game. CI runs it against
the published digest through the repository's existing smoke-test hook.

A real compatibility check additionally requires the full Steam download and
game startup, A2S readiness, RCON `serverinfo` and `server.save`, SIGTERM shutdown,
then a restart against the same volume verifying the same world creation time.
This is a server lifecycle check; a successful player connection requires a
Rust client and a reachable UDP path.
