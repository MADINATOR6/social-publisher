# Design: Studio console

Publisher reads like a piece of pro creative software at night: layered graphite panels with a faint film grain, crisp system type, and a single ember accent that only lights up what matters right now (the Publish action, live work, focus).

## Colour (Restrained: neutrals plus one accent)
| Role | Token | Value |
|---|---|---|
| Ground | `--ground` | `#0c0c0d` with 3.5% noise grain |
| Panel | `--s1` | `#141415` |
| Raised | `--s2` | `#1a1a1c` |
| Control | `--s3` | `#222225` |
| Hairline | `--line` | `rgba(255,255,255,.065)` |
| Text | `--ink` / `--ink-2` / `--ink-3` | `#f3f1ee` / `#a6a39e` / `#86837e` |
| Accent (ember) | `--ember` | `#ff6b3d` (text on it: `#1a0d07`) |
| States | `--ok` / `--wait` / `--bad` | `#3ccf8b` / `#f0b44c` / `#f0605e` |
| Demo | `--sim` | `#c6b6ff`, always dashed |

Ember is never decoration: it marks the primary action, the selected destination, focus and the live indicator. No blue anywhere.

## Type
System UI stack (SF Pro on Mac). Page title 20/600, section labels 12/600 sentence case (no tracked uppercase eyebrows), body 13, small 11.5. Monospace only for measurements: durations, sizes and resolutions. Tabular numbers for progress.

## Material and depth
Panels: `--s1`, a 1 px hairline, a 1 px inner top highlight, and an offset soft shadow (`0 16px 40px -18px rgba(0,0,0,.7)`). Radius 14 for panels, 10 for controls, 999 for chips. No nested cards: inside a panel, blocks are separated by hairlines, not boxes.

## Signature
The phone preview: the uploaded video in a 9:16 device frame, with the caption, handle and a generic action rail overlaid the way the chosen platform shows them. It updates live as the caption is typed.

## Components
- **Destination chip:** avatar, platform badge and name. On means an ember ring plus a check, off is muted, unavailable is struck through with the reason.
- **Platform tabs:** one tab per selected destination. A red dot means that tab has a problem.
- **Progress:** three-segment bars (upload, processing, live). Processing is an ember shimmer, done is green, a failure is red.
- **Buttons:** primary is filled ember, secondary is a hairline ghost, destructive turns red on hover.

## Motion
One authored moment: the live dot breathes while anything publishes. Otherwise there are only state transitions (150–200 ms, ease-out), and the stage frame turns ember while dragging.

## Prohibitions
No blue, gradients on text, glass blur, uppercase eyebrows everywhere, coloured side stripes, or nested cards.
