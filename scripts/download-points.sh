#!/usr/bin/env bash
set -euo pipefail

mkdir -p public/data/points

if gh release download points --pattern 'points.pmtiles' --dir public/data --clobber 2>/dev/null; then
  gh release download points --pattern 'manifest.json' --dir public/data/points --clobber 2>/dev/null || true
  echo "Downloaded vector tiles from GitHub release \"points\""
  ls -lh public/data/points.pmtiles
  exit 0
fi

cat <<'EOF'
GitHub release "points" not found yet.

Build vector tiles locally (requires tippecanoe + pmtiles CLI):

  yarn export-vector-tiles

Or wait for the nightly GitHub Action to publish the points release.
EOF

exit 1
