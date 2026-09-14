# FluxFilm logo & app icons

Chosen design: **Concept A "Play-F"** — a bold white "F" whose middle arm is a play button, on the
FluxFilm green gradient. The admin app uses the same mark in **rose-red** (like the admin panel today)
so the two home-screen icons can't be confused.

The PWA manifests / `<link>` tags reference these exact file names — rename nothing without updating them.

## Colours

| Use | Hex |
|---|---|
| Storefront gradient start (top-left) | `#34d399` |
| Storefront gradient end (bottom-right) | `#16a34a` |
| Admin gradient start (top-left) | `#fb7185` |
| Admin gradient end (bottom-right) | `#be123c` |
| Mark (the "F" + play) | `#ffffff` |
| Wordmark "Flux" (light background) | `#0f172a` |
| Wordmark "Film" (light background) | `#16a34a` |
| Wordmark "Flux" / "Film" (dark background) | `#ffffff` / `#4ade80` |
| Suggested manifest `theme_color` (store / admin) | `#16a34a` / `#be123c` |

Gradients run diagonally, top-left → bottom-right. Wordmark font: Plus Jakarta Sans ExtraBold (800),
converted to outlines, so the SVGs need no web font.

## Storefront files

| File | Size | Notes |
|---|---|---|
| `logo.svg` | 512×512 viewBox | Icon mark, rounded square (corner radius 112/512), transparent corners |
| `logo-wordmark.svg` | 498×120 viewBox | Icon + "FluxFilm", for light backgrounds |
| `logo-wordmark-dark.svg` | 498×120 viewBox | Same, for dark backgrounds |
| `favicon.svg` | 512×512 viewBox | Browser-tab icon (corner radius 96/512) |
| `favicon-32.png` | 32×32 | PNG favicon fallback, transparent corners |
| `icon-192.png` | 192×192 | Manifest icon, `purpose: "any"`, transparent corners |
| `icon-512.png` | 512×512 | Manifest icon, `purpose: "any"`, transparent corners |
| `icon-maskable-512.png` | 512×512 | Manifest icon, `purpose: "maskable"` — full-bleed square, mark scaled to 84% so it sits well inside the central 80% safe zone; RGB, no alpha |
| `apple-touch-icon-180.png` | 180×180 | iPhone home screen — full-bleed square (iOS rounds it), RGB, no alpha |

## Admin files (rose-red)

| File | Size | Notes |
|---|---|---|
| `admin-icon-192.png` | 192×192 | `purpose: "any"`, transparent corners |
| `admin-icon-512.png` | 512×512 | `purpose: "any"`, transparent corners |
| `admin-icon-maskable-512.png` | 512×512 | `purpose: "maskable"`, full-bleed, mark at 84%; RGB, no alpha |
| `admin-apple-touch-icon-180.png` | 180×180 | Full-bleed, RGB, no alpha |

All PNG pixel sizes were checked after rendering.

## How they were made

The mark is two paths on a 512 grid (white fill + 24px round-joined stroke):
`M154 120H360V172H214V392H154Z` (the F) and `M228 224V340L334 282Z` (the play arm).
PNGs were rendered from these SVGs with headless Chrome, then cropped to the exact size (and alpha
removed for the full-bleed icons) with `pngjs`. To make a new size, open `logo.svg` in Chrome at the
wanted width, or in any vector tool.
