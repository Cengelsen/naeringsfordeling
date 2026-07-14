#!/usr/bin/env bash
set -euo pipefail

mkdir -p data

if gh release download database --pattern organizations.db --dir data --clobber 2>/dev/null; then
  echo "Downloaded organizations.db from GitHub release \"database\""
  ls -lh data/organizations.db
  exit 0
fi

cat <<'EOF'
GitHub release "database" not found yet.

This release is created by the nightly GitHub Action after you push the repo.
Until then, build the database locally:

  yarn sync:dev    Quick dev database (~3 small kommuner, a few minutes)
  yarn sync:full   Full Norway import (hours; geocoding continues over multiple runs)

Then start the API:

  yarn server
EOF

exit 1
