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
- **Vintage crop** — only the video *inside* that rectangle is
  desaturated, given a warm sepia tint, boosted in contrast, and given a
  bit of film grain — the video outside the rectangle is untouched, full
  color.
- **Capture** — pinch your RIGHT hand's thumb and index tip together
  (one quick pinch, not a hold) to lock the frame in place and start a
  4-second countdown; hands are free to move or leave frame during the
  countdown. At zero, a photo is captured (cropped + vintage-filtered,
  same as the live preview), a shutter flash fires, and the frame unlocks
  — ready to pinch again for the next shot.
- **Sliding puzzle mini-game** — every photo has to be "unlocked" before it
  joins the strip. Right after capture, the shot is shown full-size,
  centered, for about a second, then it's split into a classic 3×3 sliding
  puzzle (9 tiles, 1 blank), shuffled into a random *solvable*
  arrangement (see below). Slide tiles with your RIGHT hand's open palm:
  hover it over a tile next to the blank to grab it, then move the palm
  toward the blank to slide the tile along that one axis — it snaps into
  place once you've dragged it far enough; closing your hand or drifting
  too far off-axis cancels the drag. Solve the puzzle (or hit the Skip
  button — see below) and the photo drops into the next open strip slot.
- **Skip button** — a circular button, bottom-center, that sends the
  *original, unpuzzled* photo straight to the strip. Click it directly,
  or hover an index fingertip (either hand) over it for 1.5 uninterrupted
  seconds — a radial ring fills in as visual feedback, and moving the
  fingertip away resets the timer.
- **Photo strip** — a classic cream photobooth strip, docked flush to the
  left edge, running the full height of the screen (straight, no tilt)
  with 4 square slots, thin margins/gaps, and a proportionally larger
  bottom margin like a real strip's "tail". Each solved (or skipped)
  puzzle fills the next slot; empty slots show a dimmed, numbered
  placeholder so you can see how many shots remain. Once all 4 are
  filled, the strip auto-composes and downloads a single combined image
  (matching the on-screen strip's proportions) and resets itself for a
  fresh round — no button click needed.

## Status

The live frame + vintage preview effect, the full capture flow, the
sliding-puzzle mini-game, and the photo strip + auto-save are all fully
implemented:

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
  thumb tip (4) and index tip (8) within `PINCH_DISTANCE_THRESHOLD_PX`
  (measured in *video pixel space*, same approach as condensate's pinch
  detection) — is edge-triggered (only the rising edge starts a
  countdown; holding the pinch doesn't retrigger, confirmed by directly
  testing that the countdown's start time doesn't reset while held)
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
- Once the 4th slot fills, `composeAndDownloadStrip()` re-crops each
  photo ("cover"-style, since captures can be any aspect ratio) into a
  cream-background canvas matching the on-screen strip's spacing/borders,
  then triggers a real browser download (`canvas.toBlob` →
  `URL.createObjectURL` → a temporary `<a download>` click) named
  `photobooth-strip-<timestamp>.png` — confirmed via intercepting the
  actual `click()` call that exactly one download fires, with the
  correct filename pattern and a valid `blob:` URL, and confirmed the
  composed canvas's exact pixel dimensions and each slot's distinct
  content/order by sampling pixels directly
- Immediately after composing, the strip resets (all 4 slots back to
  dimmed placeholders) — confirmed visually and via state inspection
- The puzzle mini-game (`PuzzleGame`) is a small, self-contained phase
  state machine (`"hidden"` → `"preview"` → `"puzzle"` → `"solved"` →
  back to `"hidden"`) that `mainLoop` defers to completely whenever it's
  active — an early-return guard means the normal frame-detection /
  pinch-lock logic doesn't run at all while a puzzle is up, so the two
  systems can never interfere with each other
- The shuffle (`shufflePuzzleBoard`) always produces a *solvable* board by
  construction — it starts from the solved state and makes a series of
  random valid slides (any sequence of legal moves can always be undone),
  rather than a naive random shuffle of all 9 positions (which is only
  solvable half the time). Independently verified over 500 trials against
  the standard inversion-count solvability test for odd-width sliding
  puzzles: 0 unsolvable boards
- Tile-dragging reuses the same distance-ratio + hysteresis open-palm
  detection technique as catscradle/neonpoint (kept local to this file,
  not shared, since the mini-game is meant to be self-contained): an open
  palm hovering over a tile adjacent to the blank arms a drag; moving the
  palm slides the tile along the one valid axis, snapping into place past
  the halfway point; closing the hand or drifting too far perpendicular
  to the slide axis cancels it. Confirmed via synthetic hand landmarks —
  correct arm/reject-by-adjacency, proportional offset while dragging,
  commit-past-threshold, hand-close cancel, and perpendicular-cancel all
  behave correctly
- The Skip button's fingertip dwell timer tracks either hand's index tip
  against the button's live bounding box every frame, drives a
  `--dwell-progress` CSS variable for the radial ring, and resets the
  instant the fingertip leaves — confirmed the ring fills proportionally,
  resets cleanly on early exit, and triggers skip exactly at 1.5s
- Both solving and skipping hand the photo off to the exact same
  `PhotoStrip.addPhoto()` used by the old direct-capture flow — solving
  passes the reconstructed image, skipping passes the original untouched
  capture — confirmed by identity-checking the photo object that lands in
  the strip in each case

Not yet built: gesture/pose validation for the *frame* (right now the
rectangle shows whenever both hands are simply detected, not specifically
when fingers are extended in an L-shape).

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
inside, normal color outside. Pinch your right hand's thumb and index
together to lock it in and start the 4-second countdown; open the
console beforehand to see each captured photo logged with a thumbnail.

After the shutter flash, the photo appears full-size for a moment, then
scrambles into a 3×3 sliding puzzle. Hold your RIGHT hand open, palm
toward the camera, and hover it over a tile next to the blank spot — then
move your palm toward the blank to slide that tile in; do this until all
9 tiles (well, 8 — one stays blank) are back in order. Or just click
"Skip" (or hover a fingertip over it for 1.5s) to send the photo to the
strip as-is. Repeat 4 times total to fill the strip (docked left) and get
an automatic download of the combined image.

## Files

- `index.html` — page structure: full-screen mirrored webcam video, overlay canvas, status bar, photo strip, Skip button
- `style.css` — full-bleed layout, styling, the photobooth-strip look, and the Skip button's radial dwell-progress ring
- `script.js` — webcam init, canvas setup, MediaPipe hand tracking, the viewfinder/vintage-crop/grain/capture/photo-strip logic, and the `PuzzleGame` sliding-puzzle mini-game (solvable shuffle, open-palm tile dragging, fingertip-dwell Skip button)
