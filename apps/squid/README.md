# squid

[Squid](https://www.squid-cache.org/) forward proxy from UBI 10 AppStream on UBI 10 minimal, built for OpenShift.

## Image notes

- **OpenShift-compatible**: runs as UID 1001 with GID 0; everything squid touches is group-0 writable, so arbitrary UIDs work.
- **Container-friendly config** (`squid.conf`): foreground process, no pid file, access log on stdout, cache/debug log on stderr (`-d 1`), memory-only cache (no `cache_dir`), `shutdown_lifetime 5 seconds` for fast pod termination.
- **Policy**: allows RFC1918/ULA clients (cluster pod networks) to ports 80/443 only, `CONNECT` to 443 only, denies everything else. Adjust by mounting a replacement `/etc/squid/squid.conf`.

## Runtime contract

- Listens on `3128`.
- No volumes required. To customize, mount a ConfigMap over `/etc/squid/squid.conf`.
- Readiness/liveness: TCP probe on 3128.
