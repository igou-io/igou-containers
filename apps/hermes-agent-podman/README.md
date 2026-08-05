# hermes-agent-podman

The official [Hermes Agent](https://github.com/NousResearch/hermes-agent)
image (`docker.io/nousresearch/hermes-agent`, date-based tags) with a nested
rootless podman stack layered on top, so the agent's terminal backend
(`terminal.backend: docker` + `HERMES_DOCKER_BINARY=podman`) runs sandbox
containers *inside* an unprivileged, user-namespaced pod — no privileged
containers, no host docker socket.

Replaces the install-at-startup pattern proven in
`igou-openshift/test-workloads/hermes-nested-podman` (devenv image +
Hermes installer into the PVC) with a pinned, s6-supervised upstream Hermes.
That workload's SCC, subuid ConfigMap, and deployment recipe are the
intended runtime pairing: `hostUsers: false`, `procMount: Unmasked`,
`io.kubernetes.cri-o.Devices: /dev/fuse,/dev/net/tun`, seccomp Unconfined,
caps `SETUID,SETGID,DAC_OVERRIDE,SETFCAP,SYS_ADMIN` (namespaced), SELinux
`container_engine_t`. Requires OpenShift 4.21+ (user namespaces GA).

What the layer adds:

- **apt**: podman, crun, fuse-overlayfs, uidmap (setuid newuidmap/newgidmap),
  passt + slirp4netns, catatonit (`podman run --init`)
- **pod-userns-sized subuid/subgid**: ranges sized for a 65536-UID pod
  namespace, split around uid 10000 so they are valid for both the stock
  `hermes` uid and an `HERMES_UID=1000` remap (the kernel rejects
  overlapping uid_map extents). Run mode is upstream's contract: start as
  container-root (unprivileged on the host under `hostUsers: false`) with
  `HERMES_UID`/`HERMES_GID` set; the s6 bootstrap remaps the hermes user
  and drops privileges — a pinned `runAsUser` is rejected by upstream
  stage2 with "started with --user"
- **storage.conf**: overlay via fuse-overlayfs (native overlay is
  unavailable to rootless podman in a pod userns)
- **containers.conf**: `label = false` — pod-level userns + SELinux are the
  boundary; nested labeling would need xattr writes a userns can never do
- **`notmpcopyup` patch** to Hermes's hardcoded `--tmpfs` flags
  (`tools/environments/docker.py`) — tmpfs copy-up preserves image SELinux
  xattrs, which is always denied in a userns. A build-time count check
  fails the build if an upstream bump reworks those flags. Drop the patch
  if upstream accepts it.

The base image's entrypoint (s6-overlay supervising `gateway run`), the
`/opt/data` state contract, and everything else are inherited unchanged.

**Dependencies managed by Renovate:**
- `FROM` line (`ARG HERMES_IMAGE`) — upstream Hermes image tag + digest
  (dockerfile manager; upstream tags are date-based `v2026.x.y`)

Debian packages are intentionally unpinned — they ride the weekly base
digest updates, same as dnf packages in the UBI-based apps.
