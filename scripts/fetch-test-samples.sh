#!/usr/bin/env bash
# Hämtar riktiga pianosamplingar (FluidR3 GM, MIT-licens, via midi-js-soundfonts)
# och avkodar dem till 48 kHz mono float32 för detektortesterna.
# Kräver curl och ffmpeg. Testerna hoppar över samplingsdelen om filerna saknas.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=tests/fixtures/samples
mkdir -p "$OUT"
BASE=https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/gh-pages/FluidR3_GM/acoustic_grand_piano-mp3
NOTES="A1 C2 E2 G2 C3 E3 F3 G3 A3 B3 C4 Db4 D4 E4 F4 Gb4 G4 Ab4 A4 B4 C5 Db5 D5 E5 G5 C6 E6 C7"
for n in $NOTES; do
  if [ ! -f "$OUT/$n.f32" ]; then
    curl -sSfL "$BASE/$n.mp3" -o "$OUT/$n.mp3"
    ffmpeg -loglevel error -y -i "$OUT/$n.mp3" -ac 1 -ar 48000 -f f32le "$OUT/$n.f32"
    rm "$OUT/$n.mp3"
  fi
done
echo "Klart: $(ls "$OUT" | wc -l) samplingar i $OUT"
