# calibre-web

OpenShift-compatible image for [Calibre-Web](https://github.com/janeczku/calibre-web).

The image installs the pinned Python application and starts through a
shell-independent entrypoint as a non-root, arbitrary UID-compatible process.
Runtime state belongs on two volumes:

- `/config` stores Calibre-Web's `app.db`, logs, and cache.
- `/books` stores the Calibre library, including `metadata.db` and ebooks.

On first start, the entrypoint copies the upstream starter `metadata.db` into
an empty writable `/books` volume. It never replaces an existing database.

The container listens on port 8083 and starts Calibre-Web with
`cps -p /config/app.db`. Calibre conversion binaries are intentionally absent;
add them only if the deployment needs format conversion.

CI builds `linux/amd64` and `linux/arm64` images and publishes
`ghcr.io/igou-io/calibre-web` after merge.
