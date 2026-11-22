# Fomalhaut identity

Design source: the user-supplied «Фомальгаут BrandBook(2).pdf» and «Нові Ассети.zip».

## Palette

- Accent: `#FB201A`
- Charcoal: `#252525`
- White: `#FFFFFF`
- Light grey: `#BFBFBF`
- Black: `#000000`

Use neutral grey surfaces, charcoal navigation, fine rules and red accents. Statuses have explicit text labels; do not depend on color alone. The orbital graphics are original supplied assets, not replacements generated for this app.

## Logo and supplied assets

The PNGs in `dist/assets` are byte-for-byte copies with portable filenames:

| Filename | Original asset |
| --- | --- |
| logo-on-dark.png | Black Logo Transparent.png |
| logo-on-light.png | White Logo Transparent.png |
| mark-red.png | Mini Logo Red.png |
| mark-white.png | Mini Logo White.png |
| mark-black.png | Mini Logo Black.png |
| orbit-red.png | Star Red.png |
| orbit-charcoal.png | Star Grey.png |
| orbit-grey.png | Star Light Grey.png |

Preserve aspect ratios, use the appropriate logo variant for the background, and leave clear space around the logo. Do not recolor or distort logo assets. Full orbital graphics may be used as supporting decoration; they are not the primary logo.

## Typography

Brand font: Proxima Nova. The supplied archive contains no font files. CSS uses locally installed Proxima Nova Regular, Semibold and Extrabold when available, with Arial/Helvetica fallbacks. It does not silently download a substitute or extract a partial font from the PDF.

For exact typography on all devices, supply licensed webfont files (WOFF2) for Regular, Semibold and Extrabold; then add the URLs to the existing @font-face rules and expose the fonts through the static server. Until then, the layout is designed to work with the fallback stack.

## Mobile application layout

The UI is mobile-first: five-tab bottom navigation, touch-friendly task cards, compact home screen, horizontally scrollable projects and bottom-sheet dialogs. Desktop uses the same workflows in a wider centered workspace with two-column content and floating bottom navigation. Keep form inputs at least 16px on phones and preserve safe-area padding. `dist/mobile.css` owns this responsive application layout above the base brand styles.
