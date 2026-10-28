# RHDH service sharing

Frontend and backend dynamic plugins for the lab's RHDH 1.10 / Backstage
1.49.4 instance. The `Service sharing` page at `/public-sharing` reads current
cluster state every 15 seconds and launches the existing `vps_public_share`
AAP job template using the caller's OAuth identity.

## Build and test

Use Node 22 and the package manager pinned in `package.json`:

```bash
yarn install --frozen-lockfile --ignore-scripts --ignore-engines
yarn typecheck
yarn test
yarn build
yarn workspace @igou/plugin-public-sharing-backend export --no-build --no-install
yarn --cwd plugins/backend/dist-dynamic install --production --ignore-scripts --ignore-engines
yarn workspace @igou/plugin-public-sharing export
podman build -t localhost/rhdh-public-sharing:dev -f Containerfile .
```

The pinned RHDH CLI exports Scalprum assets. CLI 2.x produces a different
frontend format and must not be substituted without testing the RHDH host.
Root Yarn resolutions pin security fixes in the CLI's transitive dependencies
and frontend libraries while retaining that exporter version. Changes to these
overrides must pass type checking, tests, package builds, and both dynamic
exports using the commands above.
The final image contains two packages at `/igou-plugin-public-sharing` and
`/igou-plugin-public-sharing-backend`. It has no entrypoint.

The monorepo's existing container workflow builds this image on pull requests
and publishes commit tags on `main`. The Containerfile runs tests before
exporting either plugin. Both packages must use the same image revision.
RHDH 1.10 extracts only the first OCI layer, so both packages must be copied
into the final image together. CI runs `smoke-test.sh` against the published
image to verify this layout, the backend entry point, and its private dependencies.

## Configuration

The frontend uses RHDH's authenticated `fetchApi` and backend discovery; no
OAuth token or cluster credential is sent to the browser. Configure the backend
under `publicSharing` in RHDH's app config:

```yaml
publicSharing:
  catalogUrl: https://github.com/igou-io/igou-inventory/blob/main/group_vars/all/public_sharing.yml
  aap:
    baseUrl: https://automation.apps.ocp.igou.systems
    clientId: ${RHDH_PUBLIC_SHARING_CLIENT_ID}
    clientSecret: ${RHDH_PUBLIC_SHARING_CLIENT_SECRET}
    templateName: vps_public_share
  clusters:
    ocp:
      server: https://kubernetes.default.svc
      tokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
      caFile: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
    vps:
      server: https://vps-k3s-api.vps-secrets.svc.cluster.local:6443
      tokenFile: /opt/app-root/src/public-sharing-vps-token
      caFile: /opt/app-root/src/public-sharing-vps-ca.crt
```

The existing GitHub integration supplies read access to the catalog URL.
Only approved backend fields and sharing limits are consumed; inventory
lookups are never evaluated. Sync AAP inventory after catalog changes so its
execution-time allowlist agrees with the menu.

Create a confidential authorization-code OAuth application in AAP with redirect
URI `https://rhdh.apps.ocp.igou.systems/api/public-sharing/oauth/callback`.
The plugin uses PKCE S256 and single-use, five-minute state. AAP tokens stay
in backend memory, separated by authenticated RHDH user reference. Refresh
tokens extend access within an eight-hour connection lifetime. Backend restarts
require reconnection; use one RHDH replica until a shared session store exists.
Users must have execute permission on the fixed sharing template. The owner
comes from the controller's `/me/` identity, not from a browser field or the
gateway's potentially different user ID.

## API behavior

All routes below are relative to `/api/public-sharing`. Except for the OAuth
callback, they require an authenticated RHDH **user** token; service credentials
are rejected.

- `POST /oauth/start`: returns the AAP authorization URL.
- `GET /oauth/callback`: consumes OAuth state, connects AAP, and notifies the opener.
- `POST /disconnect`: removes the local connection and revokes its AAP access and refresh tokens.
- `GET /state`: returns readiness, free ports, the caller's shares, quotas, and observation time.
- `POST /shares`: accepts `action`, `backend`, `protocol`, `port`, `leaseHours`, and `shareId` as appropriate.
- `GET /jobs/:id`: returns safe status fields for a job launched in this connection.

Every submission rereads runtime state and AAP execute permission. Only
allowlisted survey variables are sent to the fixed job template. AAP retains
the authoritative validation and serializes sharing jobs. Displayed free ports
are advisory until the job creates its resources.

Offline backends remain visible but cannot be shared. Unknown/unavailable
runtime state disables actions. `Configured` requires current route conditions,
a ready proxy endpoint, and a programmed Gateway; it does not prove external
reachability. Expired and partial shares count against budgets until cleanup
removes them. Cleanup remains hourly, and application authentication remains
independent of the Tailscale transport.

Operational credential provisioning and rollout live in
`igou-docs/openshift/RHDH and Keycloak SSO.md`.
