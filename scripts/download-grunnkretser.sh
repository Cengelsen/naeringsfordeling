#!/usr/bin/env bash
set -euo pipefail

mkdir -p public/data

ZIP="/tmp/grunnkretser-norge.zip"
URL="https://testnedlasting.geonorge.no/geonorge/Basisdata/Grunnkretser/GeoJSON/Basisdata_0000_Norge_4258_Grunnkretser_GeoJSON.zip"

echo "Downloading grunnkretser from Geonorge (~100 MB)…"
curl -fsSL -o "$ZIP" "$URL"

echo "Extracting grunnkrets polygons (EPSG:4258)…"
python3 - "$ZIP" public/data/grunnkretser.geojson <<'PY'
import json
import sys
import zipfile

zip_path, output_path = sys.argv[1:3]

with zipfile.ZipFile(zip_path) as archive:
    name = next(entry for entry in archive.namelist() if entry.endswith('.geojson'))
    with archive.open(name) as handle:
        raw = json.load(handle)

if 'Grunnkrets' in raw:
    source = raw['Grunnkrets']
elif raw.get('type') == 'FeatureCollection':
    source = raw
else:
    raise SystemExit('Unexpected grunnkretser GeoJSON structure')

features = []
for feature in source['features']:
    properties = feature.get('properties') or {}
    geometry = feature.get('geometry')
    if not geometry or geometry.get('type') not in ('Polygon', 'MultiPolygon'):
        continue

    features.append(
        {
            'type': 'Feature',
            'geometry': geometry,
            'properties': {
                'grunnkretsnummer': properties.get('grunnkretsnummer'),
                'grunnkretsnavn': properties.get('grunnkretsnavn'),
                'kommunenummer': properties.get('kommunenummer'),
            },
        }
    )

with open(output_path, 'w', encoding='utf-8') as handle:
    json.dump({'type': 'FeatureCollection', 'features': features}, handle)

print(f"Wrote {len(features)} grunnkretser to {output_path}")
PY

gzip -9 -f -k public/data/grunnkretser.geojson

echo "Downloaded grunnkrets boundaries to public/data/grunnkretser.geojson"
ls -lh public/data/grunnkretser.geojson public/data/grunnkretser.geojson.gz
