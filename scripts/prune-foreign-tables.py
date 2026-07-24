#!/usr/bin/env python3
"""Delete tables a foreign project left behind in our Convex deployment.

On 2026-07-24 another project deployed over the production deployment
(hidden-parrot-977), replacing every function and leaving ~70 of its own
tables behind. Redeploying restores our functions but cannot remove those
tables, because a code deploy never touches data.

How this works: `convex import --replace-all` deletes any table that is
neither present in the import file nor declared in the deployed schema. So we
export a snapshot, strip the foreign tables out of it, and re-import it. Our
own tables come back byte-for-byte from the snapshot we just took; the foreign
ones are dropped.

Safety:
  * A full snapshot is written to ./convex-backup-<timestamp>.zip and kept.
  * Dry run by default — it prints what it would delete and stops. Pass --yes
    to actually perform the import.
  * Refuses to run if any table declared in convex/schema.ts is missing from
    the export, which would mean the export is not trustworthy.
  * The app should be idle while this runs: writes landing between the export
    and the import would be discarded.

Usage (from the repo root, with a production deploy key):

    CONVEX_DEPLOY_KEY='prod:...' python3 scripts/prune-foreign-tables.py
    CONVEX_DEPLOY_KEY='prod:...' python3 scripts/prune-foreign-tables.py --yes
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = os.path.join(REPO, "convex", "schema.ts")


def schema_tables() -> set[str]:
    with open(SCHEMA) as fh:
        source = fh.read()
    tables = set(re.findall(r"^  ([A-Za-z][A-Za-z0-9_]*): defineTable", source, re.M))
    if len(tables) < 10:
        sys.exit(f"Only found {len(tables)} tables in convex/schema.ts — aborting.")
    return tables


def run(args: list[str]) -> None:
    print(f"$ {' '.join(args)}")
    result = subprocess.run(args, cwd=REPO)
    if result.returncode != 0:
        sys.exit(f"Command failed with exit code {result.returncode}")


def main() -> None:
    confirmed = "--yes" in sys.argv
    if not os.environ.get("CONVEX_DEPLOY_KEY"):
        sys.exit("Set CONVEX_DEPLOY_KEY to the deployment you want to prune.")

    ours = schema_tables()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = os.path.join(REPO, f"convex-backup-{stamp}.zip")
    filtered = os.path.join(REPO, f"convex-restore-{stamp}.zip")

    run(["npx", "convex", "export", "--path", backup])

    src = zipfile.ZipFile(backup)
    present = {name.split("/")[0] for name in src.namelist() if "/" in name}
    foreign = sorted(t for t in present if t not in ours and not t.startswith("_"))
    missing = sorted(t for t in ours if t not in present)

    kept = 0
    with zipfile.ZipFile(filtered, "w", zipfile.ZIP_DEFLATED) as out:
        for name in src.namelist():
            top = name.split("/")[0]
            if name == "README.md":
                out.writestr(name, src.read(name))
            elif name == "_tables/documents.jsonl":
                # Keep metadata rows only for our tables, so the foreign ones
                # are not recreated empty by the import.
                lines = [
                    line
                    for line in src.read(name).decode().splitlines()
                    if line.strip() and json.loads(line)["name"] in ours
                ]
                out.writestr(name, "\n".join(lines) + "\n")
            elif top == "_components":
                continue  # unmounted components (e.g. the foreign rateLimiter)
            elif top in ours:
                out.writestr(name, src.read(name))
                kept += 1

    print(f"\nBackup:   {backup}")
    print(f"Filtered: {filtered}  ({kept} entries from {len(ours)} declared tables)")
    print(f"\nWill DELETE {len(foreign)} foreign tables:")
    for name in foreign:
        print(f"  - {name}")
    if missing:
        print(f"\nDeclared tables absent from the export (empty in prod): {missing}")

    if not foreign:
        print("\nNothing to prune.")
        return

    if not confirmed:
        print("\nDry run. Re-run with --yes to apply.")
        return

    print("\nApplying — do not use the app until this finishes.")
    run(["npx", "convex", "import", "--replace-all", "-y", filtered])
    print("\nDone. Verify with: npx convex data")


if __name__ == "__main__":
    main()
