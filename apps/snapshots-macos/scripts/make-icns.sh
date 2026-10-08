#!/bin/bash
# Build an .icns (16 … 1024, @1x/@2x) from a 1024×1024 master PNG.
set -e
master="$1"; out="$2"
set_dir="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$set_dir"
for size in 16 32 128 256 512; do
  sips -z $size $size "$master" --out "$set_dir/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double "$master" --out "$set_dir/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$set_dir" -o "$out"
ls -la "$out"
