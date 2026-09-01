# photobooth

A webcam photobooth controlled entirely by hand gestures. Hold both hands
up in a "director's frame" — thumb and index finger tips on each hand
sketching out a rectangle — and a glowing viewfinder frame appears live on
screen, with a vintage black-and-white preview inside it, while the rest
of the (color) video stays normal.

## How it works

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
- **Vintage crop** — only the video *inside* that rectangle is
  desaturated, given a warm sepia tint, boosted in contrast, and given a
  bit of film grain — the video outside the rectangle is untouched, full
  color.
- **Capture** — pinch your RIGHT hand's thumb and index tip together and
  *hold* the pinch for a full second (a small progress ring appears at the
  pinch point so you can see it registering) to lock the frame in place
  and start a 4-second countdown; hands are free to move or leave frame
  during the countdown. Requiring a real 1-second hold — not just a single
  close-enough frame — is what keeps ordinary hand motion from
  accidentally firing a capture; letting go early (past a slightly more
  forgiving release distance, so tiny tracking jitter doesn't cancel a
  genuine hold) resets the timer, so it has to be one deliberate,
  continuous pinch. At zero, a photo is captured (cropped + vintage-
  filtered, same as the live preview), a shutter flash fires, and the
  frame unlocks — ready to pinch-and-hold again for the next shot.
- **Photo strip** — a classic cream photobooth strip, docked flush to the
  left edge, running the full height of the screen (straight, no tilt)
  with 4 square slots, thin margins/gaps, and a proportionally larger
  bottom margin like a real strip's "tail". Each capture fills the next
  slot; empty slots show a dimmed, numbered placeholder so you can see how
  many shots remain.
- **Save a photo at a custom size** — every filled strip slot has a small
  save button in its corner. Click it to open a size picker (prefilled
  with that photo's actual dimensions) where you can type whatever
  width/height you want — with "keep aspect ratio" on by default, so
  adjusting one field scales the other to match — and download just that
  one photo as a PNG at exactly the size you asked for, independent of the
  strip's fixed square slots.
- **Round-complete save choice** — once the 4th slot fills, a window pops
  up asking how to save the round, instead of auto-downloading and
  resetting right away: **Save Strip** downloads the combined strip image
  (as before), and **Save All 4** downloads each of the 4 photos as
  separate PNGs — either "Square" (the same crop the strip itself uses) or
  one custom width/height you type in, applied to all 4 (each is
  cover-cropped to that size individually, so photos with different
  original aspect ratios don't come out stretched or distorted). Both can
  be used in the same round if you want both; **Done** is what actually
  clears the strip for the next round. No new capture can start while this
  window is open.

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
- The vintage crop is drawn by `ctx.drawImage`-ing the matching region of
  the *raw* video (mapped back from canvas space to video pixel space via
  the inverse of the mirror/`object-fit: cover` math) straight onto the
  effects canvas, clipped to the rectangle, with `ctx.filter =
  "grayscale(0.9) sepia(0.2) contrast(1.15) brightness(1.03)"` — cheap,
  no manual per-pixel processing
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
  "Custom size" uses whatever width/height was typed — and downloads all 4
  as separate PNGs, staggered 250ms apart (some browsers throttle several
  downloads fired from one click). Confirmed with 4 photos of different
  aspect ratios (square, wide, tall, square) that every cropped canvas
  comes out at exactly the requested size regardless of its source shape,
  and that the crop-then-scale is always a uniform (non-distorting) scale
  by construction, since the cropped region's aspect ratio always matches
  the target's before any scaling happens
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
see a glowing rectangle appear between them, vintage black-and-white
inside, normal color outside, plus a smaller dashed gold square marking
the actual strip crop. Pinch your right hand's thumb and index together
and hold for a full second (watch the small progress ring at the pinch
point) to lock it in and start the 4-second countdown; open the console
beforehand to see each captured photo logged with a thumbnail. You can
click the small save button on any filled slot to download just that one
photo at a custom size along the way. Repeat 4 times to fill the strip
(docked left) and a window pops up asking how to save the round — the
combined strip, all 4 photos individually (square or a custom size you
type in), or both — with "Done" clearing the strip for the next round.

## Files

- `index.html` — page structure: full-screen mirrored webcam video, overlay canvas, status bar, photo strip, custom-size save modal, round-complete save-choice modal
- `style.css` — full-bleed layout, styling, the photobooth-strip look, the slot save button, and both modals
- `script.js` — webcam init, canvas setup, MediaPipe hand tracking, the viewfinder/vintage-crop/grain/strip-crop-guide/capture/photo-strip logic, the `SizePicker` custom-size save modal, and the `RoundCompleteModal` save-choice modal
