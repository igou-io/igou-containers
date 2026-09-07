#!/usr/bin/python3
"""Initialize persistent paths and start Calibre-Web."""

from __future__ import annotations

import os
import shutil
from pathlib import Path


CONFIG_DIR = Path("/config")
LIBRARY_DIR = Path("/books")
STARTER_DATABASE = Path("/app/metadata.db")


def main() -> None:
    """Seed a new library without changing an existing one, then exec cps."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    (CONFIG_DIR / ".cache").mkdir(parents=True, exist_ok=True)
    LIBRARY_DIR.mkdir(parents=True, exist_ok=True)

    library_database = LIBRARY_DIR / "metadata.db"
    if not library_database.exists():
        shutil.copyfile(STARTER_DATABASE, library_database)

    os.execv(
        "/app/.venv/bin/cps",
        ["cps", "-p", str(CONFIG_DIR / "app.db")],
    )


if __name__ == "__main__":
    main()
