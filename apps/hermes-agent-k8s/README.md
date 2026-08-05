# hermes-agent-k8s

The official [Hermes Agent](https://github.com/NousResearch/hermes-agent) image
plus the **`kubernetes` terminal backend** from our fork
([david-igou/hermes-agent#1](https://github.com/david-igou/hermes-agent/pull/1)),
a port of the closed upstream PR
[#37591](https://github.com/NousResearch/hermes-agent/pull/37591) re-scoped so
every setting lives in `config.yaml` — the reason upstream closed it.

With `terminal.backend: kubernetes` the agent runs each shell command by
exec-ing into a **per-session pod** rather than in its own container, so
untrusted commands never touch the agent's home, its credentials, or its
ServiceAccount token. Two provisioners:

- `direct` — a raw `Pod` (plus a PVC when `persistent: true`) via the core API.
- `sandbox` — a `Sandbox` CR (`agents.x-k8s.io/v1beta1`) reconciled by the
  Red Hat build of Agent Sandbox / kubernetes-sigs agent-sandbox operator.

`terminal.kubernetes.runtime_class_name: kata` puts session pods on OpenShift
sandboxed containers for per-pod VM isolation.

Sibling image: [`hermes-agent-podman`](../hermes-agent-podman) takes the other
approach — nested rootless podman inside the agent pod. This one needs no
`SYS_ADMIN`, no user namespace, and no `procMount: Unmasked`, because the
sandbox is a pod rather than a nested container.

## Why layered rather than built from source

The backend is pure Python, so the image copies only the ~19 changed modules
onto the published upstream image: ~2 minute builds instead of the 15–45 the
upstream 5-stage Dockerfile needs (SQLite from source, npm, Playwright, ffmpeg,
`uv sync`, web build), and upstream keeps owning the heavy build.

The tradeoff is real and guarded: the pinned image tag (`v2026.8.3`) and the
fork's `main` have drifted (386 files, 8 of them in this delta), so the final
build stage **imports every replaced module, asserts the backend registered,
renders a default pod template and asserts it is hardened**. If the mix is ever
incoherent the build fails loudly rather than shipping a broken image — that is
the signal to switch to a full from-source build.

## Configuration

Everything is `config.yaml` under `terminal.kubernetes.*`; there are no
`TERMINAL_KUBERNETES_*` environment variables and none should be added. The
backend has no credential of its own — in-cluster auth is the projected
ServiceAccount token the kubelet mounts.

```yaml
terminal:
  backend: kubernetes
  cwd: /workspace
  kubernetes:
    provisioner: direct          # direct | sandbox
    namespace: hermes-k8s-test
    image: ghcr.io/igou-io/igou-devenv:2026.07.27
    service_account: hermes-session-noperms
    runtime_class_name: ""       # "kata" once sandboxed containers are installed
```

The agent's own ServiceAccount needs `create pods`, **`get pods/exec`** (the
python client opens exec as a websocket-upgrading GET, not a POST — a Role
granting only `create` passes a naive check then 403s on the first command), and
in `sandbox` mode `create sandboxes.agents.x-k8s.io` instead of bare pod
creation. `hermes doctor` runs these as `SelfSubjectAccessReview`s.
`/opt/hermes/k8s/` in the image carries ready-to-edit RBAC, NetworkPolicy and
ValidatingAdmissionPolicy samples.

**Dependencies managed by Renovate:**
- `ARG HERMES_IMAGE` — upstream image tag + digest (dockerfile manager)
- `ARG HERMES_FORK_REF` — fork branch head (git-refs datasource)
- `ARG KUBERNETES_CLIENT_VERSION` — python client (pypi datasource)
- `FROM` on the source stage — UBI base digest (dockerfile manager)
