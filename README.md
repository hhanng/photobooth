# photobooth

A webcam photobooth controlled entirely by hand gestures. Hold both hands
up in a "director's frame" — thumb and index finger tips on each hand
sketching out a rectangle — and a glowing viewfinder frame appears live on
screen, with a styled preview inside it (4 looks to choose from, cycled
with a left-hand pinch), while the rest of the (color) video stays normal.

## How it works

- **Help** — a short "Photobooth controls" guide (Frame / Style / Capture,
  one line each) pops up automatically the moment the page loads, and a
  small (?) button in the top-right corner reopens it anytime afterward.
- **Signature** — a small "/by hhan/" watermark sits at the bottom-center
  of the screen at all times, and the same line is baked into the bottom
  of every saved strip.
- **Frame corners** — the bounding box of 4 points: right-hand thumb tip
  (landmark 4), right-hand index tip (8), left-hand thumb tip (4), and
  left-hand index tip (8). The rectangle is just the min/max x and y among
  those 4 points, so it updates live as your hands move.
- **Viewfinder outline** — a clean, glowing white rectangle, camera-style.
- **Strip crop guide** — a second, dimmer dashed gold square inside the
  main rectangle, labeled "strip crop", showing the square center-crop the
  photo strip will actually keep (strip slots are always square, cropped
  "cover"-style, so a wide or tall frame gets its edges trimmed). Lines up
  exactly with the eventual strip photo, so you can see while framing
  whether something important is about to get cropped off, instead of
  finding out after the shot.
- **Styled crop** — only the video *inside* that rectangle gets the active
  style's treatment — the video outside the rectangle is untouched, full
  color. Five styles, cycled with a **LEFT-hand pinch** (thumb tip
  touching index tip, one quick pinch — not held, the opposite of the
  right hand's capture gesture): **No Filter** (the default — the
  genuinely raw, unedited feed, no color/contrast adjustment at all),
  **Vintage B&W** (mostly desaturated, warm sepia tint, a little more
  contrast, subtle film grain), **Sepia** (fully desaturated then a
  strong warm-brown tint, no grain), **Vibrant Pop** (boosted saturation
  and contrast for punchy, vivid color, no desaturation at all), and
  **Star Scrapbook** (the Vintage B&W look as a base, with a decorative
  overlay of stars and sparkles composited on top — the overlay has a
  clear center and all its decoration near the edges, so it frames a
  photo without covering the subject). The current style's name shows in
  a small pill at the bottom of the screen, and applies live in the
  viewfinder so you can see it before you shoot.
- **Face beauty filters** — a second MediaPipe model, `FaceLandmarker`,
  runs alongside the hand tracker (same video, its own independent
  `detectForVideo` call each frame) and detects every face currently in
  view, up to 4 at once. Two independent toggle buttons sit at the top of
  the right-edge toolbar (🧴 Skin Smoother, 😊 Blush), styled and
  interactive exactly like the strip-pattern swatches below them: click,
  or either hand's index fingertip dwelling on one for half a second, and
  selecting an already-active toggle again turns it off. Either, both, or
  neither can be on; both apply to *every* detected face across the full
  camera feed, entirely independent of the hand-formed capture rectangle
  or which color style is active, live in the viewfinder and baked into
  the actual saved photo.
  - **Skin Smoother** layers a blurred, reduced-opacity copy of each
    face's own region back on top of the sharp video, masked to the face
    (minus the eyes, eyebrows, lips, and nostrils, which stay sharp) so
    it reads as softened skin rather than an out-of-focus face. The mask
    is built from a small set of well-established `FaceLandmarker`
    anchor points (face-edge, eye-corner, mouth-corner landmarks used
    ubiquitously across face-mesh tooling) as rotated ellipses — robust
    to head tilt — combined into one `Path2D` and clipped with the
    `evenodd` fill rule, so the exclusion zones punch cleanly out of the
    face region in a single clip call.
  - **Blush** draws a soft, strong pink-red radial gradient on both
    cheeks of every detected face — dense color at the center fading to
    fully transparent at the edge — positioned from a geometric blend of
    eye-corner, mouth-corner, and face-edge landmarks rather than a
    single less-certain "cheek" index.
- **Capture** — pinch your RIGHT hand's thumb and index tip together and
  *hold* the pinch for a full second (a small progress ring appears at the
  pinch point so you can see it registering) to lock the frame in place
  and start a 4-second countdown; hands are free to move or leave frame
  during the countdown. Requiring a real 1-second hold — not just a single
  close-enough frame — is what keeps ordinary hand motion from
  accidentally firing a capture; letting go early (past a slightly more
  forgiving release distance, so tiny tracking jitter doesn't cancel a
  genuine hold) resets the timer, so it has to be one deliberate,
  continuous pinch. At zero, a photo is captured (cropped + styled, same
  as the live preview — whatever style is active *right at that instant*
  is what gets baked in, so you can keep cycling styles during the
  countdown if you change your mind), a shutter flash fires, and the
  frame unlocks — ready to pinch-and-hold again for the next shot.
- **Photo preview + retake** — every capture shows full-screen, on its own,
  for 4 seconds before it ever reaches the strip, with **Retake** and
  **Keep** buttons underneath. Letting the 4 seconds run out counts as an
  implicit Keep, same as pressing the button; **Retake** discards the
  photo entirely and drops straight back to the live viewfinder with that
  strip slot still open. Both buttons work by click, or by either hand's
  index fingertip dwelling on one for half a second (a thin progress bar
  fills along the button's bottom edge as feedback) — the same
  dwell-to-select gesture as the strip-pattern swatches below.
- **Photo strip** — a classic photobooth strip, docked flush to the left
  edge, running the full height of the screen (straight, no tilt) with 4
  square slots, thin margins/gaps, and a proportionally larger bottom
  margin like a real strip's "tail". The space behind and between the
  photos is filled with the selected background pattern (see below), and
  every composed/downloaded strip gets a small "/by hhan/" signature
  caption in the bottom margin, regardless of pattern. Each capture fills
  the next slot; empty slots show a dimmed, numbered placeholder so you
  can see how many shots remain.
- **Strip background pattern** — a column of large round swatches (below
  the two face-beauty-filter toggles, sharing the same vertically-centered
  right-edge toolbar), one per available pattern: red stripes, blue
  stars, pink watercolor stars, Starry Night, pink glass tile, and
  leopard print (more can be added
  just by listing more image paths). Click a swatch to select it, or
  hover either hand's index fingertip over it for half a second — a
  radial ring fills in around it as feedback, and moving the fingertip
  off before it completes cancels the selection. Clicking or dwelling on
  the *already-active* swatch again deselects it, reverting the strip's
  background to plain white. Whichever pattern is selected fills the
  strip's background tiled at a "wallpaper" scale (2-3 repeats down the
  strip's height, not stretched or reduced to visual noise), and applies
  to whichever strip is actually composed next — changing it mid-round
  doesn't retroactively affect a strip already in progress.
- **Save a photo at a custom size** — every filled strip slot has a small
  save button in its corner. Click it to open a size picker (prefilled
  with that photo's actual dimensions) where you can type whatever
  width/height you want — with "keep aspect ratio" on by default, so
  adjusting one field scales the other to match — and download just that
  one photo as a PNG at exactly the size you asked for, independent of the
  strip's fixed square slots.
- **Round-complete save choice** — once the 4th slot fills, a window pops
  up asking how to save the round, instead of auto-downloading and
  resetting right away. It shows a live preview of the actual composed
  strip (pattern, all 4 photos, and the signature caption — exactly what
  "Save Strip" would produce) rather than 4 separate thumbnails.
  **Save Strip** downloads that combined strip image (as before), and
  **Save All 4** downloads each of the 4 photos as
  separate PNGs, either "Square" (the same crop the strip itself uses) or
  a custom size applied to all 4. The custom size isn't typed — hit
  "✋ Draw Size With Hands" and the window steps aside to show the live
  camera again: form the same two-hand thumb/index rectangle as the main
  frame gesture, then pinch-and-hold for a second to lock it in, exactly
  like setting up a shot (cancel any time to back out without setting
  one). Each photo is then cover-cropped to that size individually, so
  photos with different original aspect ratios don't come out stretched
  or distorted. Both Save Strip and Save All 4 can be used in the same
  round if you want both; **Done** is what actually clears the strip for
  the next round. No new capture can start while this window is open.
- **Mobile / tablet layout** — the strip and pattern-picker sizing both
  originally scaled off `window.innerHeight` alone, which looks right on
  a wide/short desktop window but would blow the strip up past half the
  screen's *width* on a narrow/tall phone, crowding out room to actually
  form the two-hand frame gesture. The strip is now also capped to a
  fraction of the viewport width (whichever constraint -- height or
  width -- is tighter wins) and, once capped, sits vertically centered
  instead of stretching top to bottom at an unreasonable size; the
  pattern swatches shrink via `clamp()` against whichever of viewport
  width/height is tighter (so a short landscape phone shrinks them too,
  not just a narrow portrait one); the status bar wraps onto more lines
  rather than overflowing behind the (?) button; and modal cards cap
  their own height with a scrollbar as a safety net on short (landscape
  phone) viewports. On a normal desktop window none of this visibly
  changes anything -- the height-based sizing stays the binding
  constraint there, same as before.

## Status

The live frame + vintage preview effect, the full capture flow, and the
photo strip + auto-save are all fully implemented:

- Webcam permission is requested and the mirrored feed is the full-screen
  background — it's the main visual, not tucked away
- MediaPipe `HandLandmarker` runs in `VIDEO` mode, tracking up to 2 hands,
  with detection/presence/tracking confidence nudged down from the 0.5
  defaults to 0.4 so both hands stay tracked reliably (the whole effect
  depends on both being detected at once)
- Handedness is read from MediaPipe's classification output and swapped
  left/right to account for the mirrored display, so "right hand" / "left
  hand" match your own sense of your hands
- Whenever both hands are detected, the 4 corner landmarks are mapped to
  canvas space and their bounding box becomes the live viewfinder
  rectangle — no gesture/pose classification yet (that's deferred; right
  now any two-hands-detected frame shows the rectangle, matching the
  scope asked for this step)
- Each of the 4 corner points is smoothed frame-to-frame with a light
  exponential moving average (`FRAME_SMOOTHING_ALPHA`, an easy-to-tune
  constant near the top of `script.js`) before the bounding rectangle is
  computed — cuts down on raw-landmark jitter noticeably (confirmed ~3.7x
  less frame-to-frame wobble under synthetic jitter) while still catching
  up to real intentional hand movement within roughly 100-130ms, so it
  reads as smoothed rather than laggy. Resets to a hard snap (no smoothing
  in from a stale position) whenever both hands stop being detected and
  then reappear
- The styled crop is drawn by `ctx.drawImage`-ing the matching region of
  the *raw* video (mapped back from canvas space to video pixel space via
  the inverse of the mirror/`object-fit: cover` math) straight onto the
  effects canvas, clipped to the rectangle, with `ctx.filter` set to the
  active style's CSS filter-function string — cheap, no manual per-pixel
  processing
- The 4 styles (`STYLES`, near the top of `script.js`) are each just a
  filter string plus optional `grain`/`overlaySrc` flags: **Vintage B&W**
  (`grayscale(0.9) sepia(0.2) contrast(1.15) brightness(1.03)`, grain on),
  **Sepia** (`grayscale(1) sepia(0.85) contrast(1.05) brightness(1.02)`,
  no grain), **Vibrant Pop** (`saturate(1.9) contrast(1.25)
  brightness(1.05)`, no grain, no desaturation at all), and **Star
  Scrapbook** (Vintage B&W's exact filter, plus `overlaySrc:
  "assets/scrapbook-overlay.png"`). `drawStylePostProcessing()` applies
  the grain and/or overlay and is shared byte-for-byte between the live
  preview and `capturePhoto()`, so the two always match exactly
- A left-hand pinch cycles `StyleState.index` through `STYLES`, wrapping
  after the last one — single-trigger on the rising edge (`isPinching`
  with hysteresis, same function the right hand's capture pinch uses, just
  called on the other hand with its own independent `leftWasPinching`
  state) rather than held, so it can't be confused with the right hand's
  pinch-and-hold. Verified by replaying both hands' pinch logic together
  against controlled synthetic distances: the style advances exactly once
  per left pinch (not again while held), a right-hand pinch starting or
  ending has zero effect on the style index, and a left-hand pinch
  starting or ending has zero effect on the right hand's hold timer —
  each hand's gesture is entirely independent of the other's
- The scrapbook overlay (`assets/scrapbook-overlay.png`, a 1080×1080 PNG
  with stars/sparkles scattered near the edges and a clear transparent
  center) is preloaded once at startup (`preloadStyleOverlays()`) and, for
  Star Scrapbook, drawn stretched to exactly the destination rect's
  width/height — no runtime placement logic, since the asset is already
  composed. Verified by capturing the same synthetic photo as both Vintage
  B&W and Star Scrapbook and diffing every pixel: ~2.9% differ (matching
  the overlay's sparse edge decoration), and the two match exactly at the
  center point, confirming the "clear center" claim in practice, not just
  by looking at the source image
- The active style's name shows in a small pill at the bottom of the
  screen (`#style-label`, updated by `updateStyleLabel()` on every cycle
  and once at startup) and is always visible, not just while framing, so
  you know what's selected before you even hold your hands up
- Since the crop is drawn fresh (not just borrowed from the already-
  mirrored `<video>` element), it gets its own small horizontal flip
  scoped to just that draw, so it matches the mirrored orientation of the
  color video around it
- Film grain is a handful of pre-rendered static noise tiles (built once
  at startup, not per frame) cycled every few frames and blended in with
  `globalCompositeOperation: "overlay"` at low alpha
- The frame outline is a glowing rectangle (soft wide pass + crisp thin
  core), drawn *outside* the clip so its glow can bleed past the edge
- Capture is a small phase state machine (`CaptureState.phase`: `"idle"`
  → `"countdown"` → `"flash"` → back to `"idle"`). A right-hand pinch —
  thumb tip (4) and index tip (8), measured in *video pixel space* (same
  approach as condensate's pinch detection) — has to be held continuously
  for `PINCH_HOLD_MS` (1 second) before it triggers a countdown, tracked
  via `CaptureState.pinchStartMs`; a single close-enough frame isn't
  enough on its own, which is what stops an incidental thumb/index graze
  during normal hand motion from firing a capture by itself. Pinch
  detection uses two thresholds instead of one (`PINCH_ENTER_THRESHOLD_PX`
  / `PINCH_EXIT_THRESHOLD_PX`, 42px/58px) — once a pinch starts, the
  fingers have to move past the *larger* exit distance to count as
  released, so ordinary landmark jitter right at one fixed boundary can't
  flicker the state and reset the hold. Any real break resets the timer
  entirely (two short pinches don't add up to one long one), and a small
  radial progress ring is drawn at the pinch point while a hold is
  in-progress. Verified by replaying the exact algorithm against
  controlled synthetic timings/distances: the hold accumulates correctly
  across frames, fires exactly once at the 1-second mark (not before, not
  twice), a break well past the exit threshold correctly zeroes the timer,
  and a second attempt after a break needs its own full fresh second (no
  credit carried over from the first, aborted attempt)
- Entering `"countdown"` locks the rectangle's exact canvas coordinates
  (`CaptureState.lockedRect`); the countdown and flash phases render from
  that locked geometry regardless of what the hands do afterward —
  confirmed by moving/removing synthetic hands entirely mid-countdown and
  checking the rectangle drawn (and later, the captured photo's
  dimensions) still matched the original lock exactly
- At zero, `capturePhoto()` re-derives the same source-rectangle math as
  the live preview (`mapCanvasToVideo` on the locked rect's corners),
  renders it to its own small canvas at the rect's own pixel size with
  the identical vintage filter + grain treatment, and pushes
  `{ canvas, dataUrl, width, height, timestamp }` onto the in-memory
  `capturedPhotos` array — confirmed pixel-for-pixel consistent with the
  live preview via the same gradient/luminance test used to verify the
  crop math originally
- A brief full-screen white flash (fading out over `FLASH_DURATION_MS`)
  fires the instant a photo is captured, then the countdown number
  overlay (see below) gives way back to idle
- The countdown itself is large, centered text in the locked rectangle,
  ticking 4→3→2→1 with a quick scale-in "pop" at the start of each second
- Each captured photo is logged to the console: dimensions/count as text,
  plus an inline thumbnail (the DevTools trick of a styled `background:
  url(dataUrl)` on an empty log)
- The strip (`PhotoStrip`) owns its own round-scoped array of up to 4
  photos, separate from the full historical `capturedPhotos` log — a
  strip reset doesn't erase console history, and a fresh round always
  starts clean regardless of how many photos have ever been taken.
  Confirmed a mid-round state (2 of 4 filled) shows exactly 2 real
  thumbnails and 2 dimmed numbered placeholders
- `PhotoStrip.layout()` computes the slot size and every margin/gap from
  `window.innerHeight` (via the `STRIP_*_RATIO` constants near the top of
  `script.js`) and sets them as CSS custom properties on the root
  element, so the strip's CSS always exactly spans top to bottom with
  square slots at any viewport size, and `#status-bar` reads the same
  `--strip-width` variable to avoid overlapping it. Re-run on `resize`
- Once the 4th slot fills, `PhotoStrip.addPhoto()` hands off to
  `RoundCompleteModal` instead of auto-downloading — `mainLoop` checks
  `RoundCompleteModal.isOpen` right at the top and skips all
  frame-detection/pinch-hold/capture logic entirely while it's up (same
  early-return-gate pattern used for the old puzzle mini-game), so a
  capture can't start mid-decision and land on an already-full strip
- `RoundCompleteModal`'s "Save Strip" button calls `composeAndDownloadStrip()`,
  which re-crops each photo ("cover"-style, since captures can be any
  aspect ratio) into a cream-background canvas matching the on-screen
  strip's spacing/borders, then triggers a real browser download
  (`canvas.toBlob` → `URL.createObjectURL` → a temporary `<a download>`
  click) named `photobooth-strip-<timestamp>.png`
- "Save All 4" cover-crops each of the 4 photos individually to the chosen
  size (`cropPhotoToCanvas`, sharing the exact same crop math as the strip
  via `computeCoverCropRect`) — "Square" uses the strip's own slot size,
  "Custom size" uses whatever was drawn by hand — and downloads all 4 as
  separate PNGs, staggered 250ms apart (some browsers throttle several
  downloads fired from one click). Confirmed with 4 photos of different
  aspect ratios (square, wide, tall, square) that every cropped canvas
  comes out at exactly the requested size regardless of its source shape,
  and that the crop-then-scale is always a uniform (non-distorting) scale
  by construction, since the cropped region's aspect ratio always matches
  the target's before any scaling happens
- The custom size is set by gesture, not typed: `RoundCompleteModal.
  updateSizeGesture()` mirrors the main capture flow's rectangle-forming
  (both hands' thumb/index tips, EMA-smoothed) and pinch-hold-to-confirm
  logic almost exactly, but locks in a *size* instead of starting a
  countdown. It's driven from `mainLoop` itself while `pickingSize` is
  true (the modal card hides so the live camera is visible underneath) —
  confirmed via synthetic hand landmarks that the rectangle tracks both
  hands, a pinch has to be held the same `PINCH_HOLD_MS` before it
  confirms, and confirming maps the drawn rectangle's on-screen corners
  back to native video-pixel space with the same `mapCanvasToVideo` math
  the real photo capture uses — so a bigger hand-drawn rectangle means a
  bigger exported photo, consistent with how framing works everywhere
  else in the app. "Save All 4" is disabled whenever "Custom size" is
  selected but nothing has been drawn yet, and re-enables the instant a
  size is confirmed; "Cancel" backs out without setting anything
- Both "Save Strip" and "Save All 4" can be used in the same round (verified
  by triggering both and checking all 5 resulting downloads); only "Done"
  actually calls `PhotoStrip.reset()` — confirmed clicking it clears
  `RoundCompleteModal.isOpen`, hides the modal, and resets all 4 slots back
  to dimmed placeholders
- The strip crop guide (`drawStripCropGuide`) computes a square of side
  `min(rectW, rectH)` centered in the live rectangle — the exact same
  "cover"-crop math `drawStripSlotImage` uses when compositing the strip —
  so what's inside the dashed gold square is exactly what ends up in the
  strip; skipped entirely once the rectangle is already square, since the
  guide would just retrace the main frame's own edges
- Each filled strip slot's save button opens `SizePicker`, a small modal
  prefilled with that photo's real width/height; toggling either field
  with "keep aspect ratio" on recomputes the other from the photo's
  original aspect ratio, and "Save PNG" draws the photo into a canvas at
  exactly the chosen size and downloads it as
  `photobooth-photo-<timestamp>-<width>x<height>.png` — confirmed the
  aspect-lock math and that the actual download's filename/dimensions
  match what was typed, by intercepting the real download click
- `HelpModal` opens once automatically during `init()` (before the
  webcam/hand-tracker even finish loading) and gates `mainLoop` the same
  way the other modals do — an early-return before any hand-detection or
  capture logic runs, confirmed `CaptureState.phase` never advances while
  it's open. The (?) button and a click on the dimmed backdrop both call
  the same `close()`. Its copy is fixed, plain text (no emoji): a
  "Photobooth controls" heading, one line each for Frame/Style/Capture,
  and a small "/by hhan/" signature line above the close button
- `#on-screen-signature` is a plain, always-visible "/by hhan/" element,
  bottom-center, independent of any modal — positioned close enough to
  the very bottom edge (with a small font size) to leave a confirmed
  clear gap from `#style-label` (which sits just above it, bottom-left
  near the strip) even at a narrow test viewport where the two are
  closest; a light `text-shadow` keeps the plain black text legible over
  a dark video feed instead of just vanishing into it
- `STRIP_PATTERNS` is just a list of image paths — `PatternPicker.init()`
  builds one swatch button per entry, so adding a pattern later is only
  ever appending a path there, nothing else to touch. Each composed strip
  reads `StripPatternState.index` fresh via `fillStripBackground()`, which
  fills the canvas with `ctx.createPattern(..., "repeat")` (falling back
  to the old flat cream color if the image hasn't finished loading). The
  on-screen strip mirrors the same selection through a `--strip-pattern`
  CSS custom property, updated by `updateOnScreenStripPattern()` whenever
  the selection changes
- The source pattern images are much higher-resolution than the strip is
  wide, so tiling them at native size showed only a tiny, zoomed-in crop
  of one repeat rather than a proper repeating motif with visible detail
  (looked "stretched" even though nothing was actually being scaled up).
  `STRIP_PATTERN_TARGET_REPEATS` (one constant, near `STRIP_PATTERNS`,
  currently 2.5) fixes this directly in the unit that actually matters:
  how many times a pattern repeats *down the strip's height* — each
  tile's height is `stripHeight / STRIP_PATTERN_TARGET_REPEATS`, width
  auto-scaled to preserve the source's own aspect ratio.
  `scalePatternForTiling()` pre-scales each pattern down to a small
  offscreen canvas once, by height (cached in `stripPatternTileCanvases`,
  keyed by path), for the composed/downloaded strip — whose total height
  is fixed (`STRIP_COMPOSE_SLOT_SIZE * STRIP_TOTAL_RATIO_UNITS`, a shared
  constant with `PhotoStrip.layout()` so the two never drift apart) — and
  a matching `--strip-pattern-tile-size` CSS variable (`window.innerHeight
  / STRIP_PATTERN_TARGET_REPEATS`, set alongside the strip's other
  responsive sizing) drives `background-size: auto <height>` for the live
  strip. Confirmed the math directly (on-screen tile height, repeat count,
  and every pre-scaled canvas's dimensions all matched the constant
  exactly) and visually (leopard print and Starry Night both show large,
  clearly-detailed repeats — 2-3 down the strip — in a rendered composed
  strip, not a small busy scatter)
- `blue-stars.png` had a solid grey ~5%-of-height border baked into the
  source file itself (top and bottom); tiling that border repeated it as
  a visible grey seam between-repeats. Fixed by cropping the source image
  file directly (with a safety margin past the measured edge, confirmed
  by sampling pixels near the new edges) rather than in code, since
  that's a defect in that one asset, not something the general tiling
  logic should special-case
- The pattern-picker is a single column (`flex-direction: column`),
  vertically centered on the screen and right-aligned
  (`top: 50%; transform: translateY(-50%); right: 1rem`), rather than a
  row in a bottom corner — confirmed its vertical center exactly matches
  the viewport's at both a short test-harness viewport and a realistic
  1280×800 size, and that it doesn't overlap the (?) help button or the
  style label at either size. Swatches themselves are 60px (up from
  38px); the dwell-gesture hit-testing needed no code changes at all
  since it already reads each swatch's live `getBoundingClientRect()`
  every frame rather than assuming a fixed size or position — confirmed
  by re-running the two-hand dwell test after the resize/reposition and
  getting the same correct result
- `.pattern-swatch-ring` used to render at all times (just filled with a
  faint `rgba(255,255,255,0.15)` when not mid-dwell, from the conic
  gradient's own "remainder" color), which showed as a constant soft halo
  around every swatch even at rest. Fixed by hiding it (`opacity: 0`) by
  default and only revealing it (`opacity: 1`) while `.dwelling` is
  actually applied to that swatch, so the ring only ever appears during a
  real two-hand dwell attempt
- `PatternPicker.updateDwell()` runs every frame regardless of
  `CaptureState.phase` (confirmed it still arms during a forced
  `"countdown"` phase) — it requires **both** hands' index fingertips
  (landmark 8) inside the *same* swatch's `getBoundingClientRect()`
  simultaneously; either hand missing, or the two on different swatches,
  resets the dwell entirely. Verified the full sequence with synthetic
  landmarks: one hand alone never arms it, both hands together arms it,
  progress reaches exactly 0.5 at the halfway point, either fingertip
  leaving before completion cancels and zeroes the ring, and re-entering
  together and holding past `PATTERN_DWELL_MS` selects it — confirmed by
  checking `StripPatternState.index` actually changed, not just the dwell
  state
- `drawStripSignature()` draws `STRIP_SIGNATURE_TEXT` ("/by hhan/") in
  plain black text, centered in the bottom margin band, sized as a
  fraction of that band's height — confirmed by rendering a real composed
  strip and visually inspecting the bottom margin, on top of the pattern,
  present regardless of which pattern is selected since it's the very
  last thing drawn onto the canvas

Not yet built: gesture/pose validation (right now the rectangle shows
whenever both hands are simply detected, not specifically when fingers
are extended in an L-shape).

## Stack

- Plain HTML/CSS/JS, no build step
- [MediaPipe Tasks Vision](https://developers.google.com/mediapipe/solutions/vision/hand_landmarker) (`HandLandmarker`, via jsdelivr CDN) for two-hand tracking
- Canvas 2D for the frame/vintage-crop/grain rendering

Mirrors the architecture of [condensate](../condensate),
[neonpoint](../neonpoint), and [catscradle](../catscradle) (sibling
projects) — same CDN/model setup and module structure — but is otherwise
a separate, standalone project.

## Running locally

Webcam access requires HTTPS or `localhost`, so open this over a local
static server rather than as a `file://` URL.

```bash
npx serve .
```

or

```bash
python3 -m http.server 8000
```

Then open the printed local URL (e.g. `http://localhost:3000` or
`http://localhost:8000`) in a browser, grant camera access when prompted,
and hold both hands up with your thumb and index fingertips out — you'll
see a glowing rectangle appear between them, styled inside, normal color
outside, plus a smaller dashed gold square marking the actual strip crop.
Pinch your LEFT hand's thumb and index together (one quick pinch) to
cycle through the 4 styles — Vintage B&W, Sepia, Vibrant Pop, Star
Scrapbook — watching the name change at the bottom of the screen and the
preview update live. Pinch your RIGHT hand's thumb and index together and
hold for a full second (watch the small progress ring at the pinch point)
to lock it in and start the 4-second countdown; open the console
beforehand to see each captured photo logged with a thumbnail. You can
click the small save button on any filled slot to download just that one
photo at a custom size along the way, and click (or two-hand dwell on) a
swatch in the column on the right to change the strip's background
pattern. Repeat 4 times to fill the strip (docked left) and a window
pops up asking how to save the round — the combined strip (patterned
background, "/by hhan/"
caption at the bottom), all 4 photos individually (square, or a custom
size you draw with your hands the same way you framed the shots), or
both — with "Done" clearing the strip for the next round.

## Files

- `index.html` — page structure: full-screen mirrored webcam video, overlay canvas, status bar, photo strip, style label, pattern picker, help button + guide modal, custom-size save modal, round-complete save-choice modal
- `style.css` — full-bleed layout, styling, the photobooth-strip look, the style label, the pattern swatches, the help button/modal, the slot save button, and the other modals
- `script.js` — webcam init, canvas setup, MediaPipe hand tracking, the viewfinder/style-presets/strip-crop-guide/capture/photo-strip logic, the `SizePicker` custom-size save modal, the `RoundCompleteModal` save-choice modal, and the `PatternPicker` strip background picker
- `assets/scrapbook-overlay.png` — the decorative stars/sparkles overlay used by the Star Scrapbook style
- `assets/strip-patterns/` — the 6 selectable strip background patterns (`red-stripes.png`, the default, plus `blue-stars.png`, `pink-watercolor-stars.png`, `starry-night.png`, `pink-glass-tile.png`, `leopard.png`)
