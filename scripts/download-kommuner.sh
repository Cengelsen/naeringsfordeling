#!/usr/bin/env bash
set -euo pipefail

mkdir -p public/data

curl -fsSL \
  -o public/data/kommuner.geojson \
  https://raw.githubusercontent.com/robhop/fylker-og-kommuner/main/Kommuner-S.geojson

gzip -9 -f -k public/data/kommuner.geojson

echo "Downloaded kommune boundaries to public/data/kommuner.geojson"
ls -lh public/data/kommuner.geojson public/data/kommuner.geojson.gz
