# FluxFilm logo & app icons

Chosen design: **"Play-F" (A2, midnight)** — a big soft play button with the letter **F** cut into it, in a
mint gradient on a midnight-green tile, with a gentle top highlight and soft shadow. The play shape is the hero
so it reads as "video / watch" instantly; the F is the quiet brand detail.

The admin app uses the same mark in **rose on a deep wine tile**, so the two home-screen icons can't be confused.

The PWA code serves these exact file names from `/icons/` — rename nothing without updating it.

## Colours

| Use | Hex |
|---|---|
| Storefront tile gradient (top-left → bottom-right) | `#12382a` → `#04140e` |
| Storefront mark gradient (top → bottom) | `#a7f3d0` → `#34d399` |
| Admin tile gradient (top-left → bottom-right) | `#3f0f20` → `#12040a` |
| Admin mark gradient (top → bottom) | `#fecdd3` → `#fb7185` |
| Top highlight | `#ffffff` at 16% → 0% (radial, from the top-left) |
| Mark shadow | `#000000` at 45%, 10px down, 12px blur (on the 512 grid) |
| Wordmark on light: "Flux" / "Film" | `#0b2a1f` / `#059669` |
| Wordmark on dark: "Flux" / "Film" | `#ffffff` / `#6ee7b7` |
| Suggested manifest `theme_color` / `background_color` (store) | `#04140e` |
| Suggested manifest `theme_color` / `background_color` (admin) | `#12040a` |

Wordmark font: Plus Jakarta Sans ExtraBold (800), converted to outlines, so the SVGs need no web font.

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
| `apple-touch-icon-180.png` | 180×180 | iPhone home screen — full-bleed square (iOS rounds it), mark at 90%, RGB, no alpha |

## Admin files (rose on wine)

| File | Size | Notes |
|---|---|---|
| `admin-logo.svg` | 512×512 viewBox | Admin icon mark, rounded square — used in the admin panel sidebar + login |
| `admin-icon-192.png` | 192×192 | `purpose: "any"`, transparent corners |
| `admin-icon-512.png` | 512×512 | `purpose: "any"`, transparent corners |
| `admin-icon-maskable-512.png` | 512×512 | `purpose: "maskable"`, full-bleed, mark at 84%; RGB, no alpha |
| `admin-apple-touch-icon-180.png` | 180×180 | Full-bleed, mark at 90%; RGB, no alpha |

All PNG pixel sizes were checked after rendering.

## How they were made

On a 512 grid: the play button is the triangle `M170 128V384L392 256Z` (moved 8px right), filled and stroked
64px with round joins so the corners are soft. The F is cut out with a mask of three rounded bars:
stem `x198 y186 w36 h148`, top arm `x198 y186 w98 h32`, middle arm `x198 y244 w78 h30` (corner radius 6).
PNGs were rendered from the SVGs with headless Chrome, then cropped to the exact size (and alpha removed for
the full-bleed icons) with `pngjs`. For a new size, open `logo.svg` in Chrome at that width or in any vector tool.

## Saved alternate: A1 midnight (not in use)

`alternates/` keeps the runner-up the owner liked, so it can replace the current mark later:
an **F with a separate play triangle** beside the stem, mint `#6ee7b7` on the same midnight-green tile
(admin version: `#fda4af` on wine). Same top highlight and shadow as the live icon.

| File | Notes |
|---|---|
| `alternates/a1-midnight-logo.svg` | Store icon, 512×512 viewBox, rounded square |
| `alternates/a1-midnight-admin-logo.svg` | Admin icon, 512×512 viewBox |
| `alternates/a1-midnight-512.png` | 512×512 preview |

Geometry on the 512 grid, all moved 22px left: F `M150 118H352V172H212V394H150Z` (22px round-joined stroke),
play `M290 212V352L408 282Z` (30px round-joined stroke). To switch, render the same file names as above from
these SVGs (maskable at 84%, apple-touch at 90%, full-bleed without alpha).
