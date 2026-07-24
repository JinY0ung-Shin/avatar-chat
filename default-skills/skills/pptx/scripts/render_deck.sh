#!/usr/bin/env bash
# Render a .pptx into per-slide PNGs: soffice (pptx -> pdf), then pdftoppm
# (pdf -> png). Output lands in <output-dir>/slide-N.png, one file per slide.
#
# Usage: render_deck.sh <deck.pptx> <output-dir> [dpi]
#
# Why pdf in the middle: `soffice --convert-to png` renders only the FIRST
# slide of a pptx; pdf keeps every page. Why the throwaway profile: parallel
# soffice runs would otherwise fight over the shared user profile's lock file.
set -euo pipefail

deck="${1:?usage: render_deck.sh <deck.pptx> <output-dir> [dpi]}"
out="${2:?usage: render_deck.sh <deck.pptx> <output-dir> [dpi]}"
dpi="${3:-120}"

[ -f "$deck" ] || { echo "deck not found: $deck" >&2; exit 1; }
command -v soffice >/dev/null 2>&1 || {
  echo "soffice is not installed in this image - PPT rendering unavailable (a system administrator must rebuild the server image)" >&2
  exit 1
}
command -v pdftoppm >/dev/null 2>&1 || {
  echo "pdftoppm (poppler-utils) is not installed in this image - PPT rendering unavailable (a system administrator must rebuild the server image)" >&2
  exit 1
}

mkdir -p "$out"
profile="$(mktemp -d "${TMPDIR:-/tmp}/lo-profile-XXXXXX")"
trap 'rm -rf "$profile"' EXIT

timeout 120 soffice --headless --norestore "-env:UserInstallation=file://$profile" \
  --convert-to pdf --outdir "$out" "$deck" >/dev/null

base="$(basename "$deck")"
pdf="$out/${base%.*}.pdf"
[ -f "$pdf" ] || { echo "conversion produced no pdf: $pdf" >&2; exit 1; }

timeout 120 pdftoppm -png -r "$dpi" "$pdf" "$out/slide"

ls "$out"/slide-*.png >/dev/null 2>&1 || { echo "no slide PNGs produced from $pdf" >&2; exit 1; }
echo "Rendered slides:"
ls -1 "$out"/slide-*.png
