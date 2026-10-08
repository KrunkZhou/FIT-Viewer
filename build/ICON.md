# Application icon

`icon-source.png` is an original bitmap generated with the built-in image tool,
not an asset from the previous FIT File Viewer. It is the common source for the
web favicon and desktop icons. Regenerate the checked-in sizes on macOS with
`node scripts/build-icons.mjs`. Builds do not require image-generation tools.

Generation prompt:

> Use case: logo-brand. Create one original production application icon for FIT Viewer, a local fitness sensor file analysis tool for web, Windows and macOS. A bold white folded-corner document symbol containing one clear mint/emerald activity waveform on a deep emerald rounded-square tile. Flat graphic design, very simple geometry and thick strokes, understated premium utility app, clean edges, high contrast, recognizable at 16 and 32 pixels. Center the tile at 88 percent of the square canvas with transparent margins and transparent corners. No text, no letters, no fine grids, no photorealism, no external brand references, no extra objects, no watermark. Export a square high-resolution icon.

Generated with transparent background enabled. PNG resizing uses macOS `sips`;
ICNS packaging uses `iconutil`; ICO stores multiple PNG resolutions.
