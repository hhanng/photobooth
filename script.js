import {
  FilesetResolver,
  HandLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

// --- Hand tracking ---------------------------------------------------------
const MEDIAPIPE_WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const MAX_HANDS = 2;

// Thumb tip (4) and index tip (8) on each hand -- the "director's frame"
// gesture's four corner-defining points.
const THUMB_TIP = 4;
const INDEX_TIP = 8;

// Exponential-moving-average smoothing applied to each of the 4 corner
// points, frame to frame, before the bounding rectangle is computed from
// them -- cuts down on raw-landmark jitter so the frame doesn't twitch.
// 0..1: lower = smoother but laggier, higher = snappier but more jittery.
// Tune this to taste.
const FRAME_SMOOTHING_ALPHA = 0.35;
// -------------------------------------------------------------------------

// --- Viewfinder frame look --------------------------------------------
const MIN_FRAME_SIZE = 24; // px, guards against a degenerate/zero-size rect
const FRAME_COLOR = "rgb(255, 255, 255)";
const FRAME_GLOW_BLUR = 14;
const FRAME_GLOW_WIDTH = 5;
const FRAME_GLOW_ALPHA = 0.35;
const FRAME_CORE_WIDTH = 1.5;
// -------------------------------------------------------------------------

// --- Strip crop guide ----------------------------------------------------
// A second, dimmer dashed square drawn inside the live viewfinder rect,
// showing the square center-crop the photo strip will actually keep (strip
// slots are always square, cropped "cover"-style -- see drawStripSlotImage)
// -- so while framing, the user can see exactly what will end up in the
// strip instead of guessing and getting the edges cropped off later.
const STRIP_GUIDE_COLOR = "rgb(255, 214, 130)"; // warm gold, distinct from the white frame
const STRIP_GUIDE_ALPHA = 0.55;
const STRIP_GUIDE_LINE_WIDTH = 1.5;
const STRIP_GUIDE_DASH = [8, 6];
// -------------------------------------------------------------------------

// --- Capture gesture (right-hand pinch, held) + countdown/flash ---------
// Pinch distance is measured in VIDEO PIXEL space (not normalized, not
// canvas space) -- same approach/threshold ballpark as condensate's pinch
// detection, so a "pinch" means the same physical thing across projects.
// Two thresholds (hysteresis), not one: once a pinch starts, the fingers
// have to move noticeably farther apart (past the larger EXIT distance)
// before it counts as released, so ordinary landmark jitter right at one
// fixed boundary can't flicker the state and reset the hold timer.
const PINCH_ENTER_THRESHOLD_PX = 42;
const PINCH_EXIT_THRESHOLD_PX = 58;
// The pinch has to be held continuously for this long before it triggers
// the countdown -- a single-frame "distance < threshold" trigger can't
// tell a deliberate pinch apart from thumb and index briefly grazing each
// other during normal hand motion; requiring a real hold filters that out.
const PINCH_HOLD_MS = 1000;
const COUNTDOWN_SECONDS = 4;
const COUNTDOWN_POP_DURATION_S = 0.25; // each number eases in from a larger scale over this long
const FLASH_DURATION_MS = 300;
// -------------------------------------------------------------------------

// --- Style presets + film grain ------------------------------------------
// Each style is a CSS ctx.filter string plus optional extras (grain, a
// decorative overlay image) applied to the video feed inside the frame
// rectangle. Cycled by a left-hand pinch (see StyleState below); the
// active one renders live in the viewfinder and is exactly what
// capturePhoto() bakes into the saved photo.
const STYLES = [
  {
    name: "Vintage B&W",
    // Desaturate most of the way, a touch of warm sepia tint, a little
    // more contrast, and slightly lifted brightness so it doesn't read
    // as just "dark and drab".
    filter: "grayscale(0.9) sepia(0.2) contrast(1.15) brightness(1.03)",
    grain: true,
    overlaySrc: null,
  },
  {
    name: "Sepia",
    // Fully desaturate first, then a strong sepia tint -- warmer and
    // browner than Vintage B&W, no grain (grain reads as "old photo",
    // sepia here is more "warm keepsake tone").
    filter: "grayscale(1) sepia(0.85) contrast(1.05) brightness(1.02)",
    grain: false,
    overlaySrc: null,
  },
  {
    name: "Vibrant Pop",
    // The opposite direction entirely: boosted saturation + contrast for
    // punchy, vivid color, no desaturation/tinting at all.
    filter: "saturate(1.9) contrast(1.25) brightness(1.05)",
    grain: false,
    overlaySrc: null,
  },
  {
    name: "Star Scrapbook",
    // Vintage B&W as the base look, then the decorative overlay gets
    // composited on top in drawStylePostProcessing -- the overlay image
    // itself already has all the stars/sparkles positioned with a clear
    // center, so no runtime placement logic is needed here.
    filter: "grayscale(0.9) sepia(0.2) contrast(1.15) brightness(1.03)",
    grain: true,
    overlaySrc: "assets/scrapbook-overlay.png",
  },
];

// Loaded once at startup, keyed by overlaySrc -- see preloadStyleOverlays().
const styleOverlayImages = {};

function preloadStyleOverlays() {
  for (const style of STYLES) {
    if (!style.overlaySrc || styleOverlayImages[style.overlaySrc]) continue;
    const img = new Image();
    img.src = style.overlaySrc;
    styleOverlayImages[style.overlaySrc] = img;
  }
}

// Grain: a handful of pre-rendered static noise tiles (built once, not
// per-frame) cycled every few frames for a subtle flicker, blended with
// "overlay" at low alpha over the filtered crop.
const GRAIN_TILE_SIZE = 128;
const GRAIN_TILE_COUNT = 3;
const GRAIN_ALPHA = 0.08;
const GRAIN_CYCLE_FRAMES = 4;

// Cycled by a left-hand pinch, single-trigger (rising edge, not held) --
// deliberately the opposite of the right hand's pinch-and-hold, so the
// two gestures feel distinct and can't be confused for one another.
const StyleState = {
  index: 0,
  leftWasPinching: false,
};

function cycleStyle() {
  StyleState.index = (StyleState.index + 1) % STYLES.length;
  updateStyleLabel();
}

function updateStyleLabel() {
  const el = document.getElementById("style-label");
  if (el) el.textContent = STYLES[StyleState.index].name;
}

// Draws a style's grain (if any) and decorative overlay (if any) on top of
// an already-filtered photo draw, at the given destination rect -- shared
// between the live preview (a clipped region of the shared canvas) and
// capturePhoto (its own small canvas), so the two stay pixel-for-pixel
// consistent.
function drawStylePostProcessing(ctx, style, x, y, w, h) {
  if (style.grain) {
    const tile = grainTiles[Math.floor(grainFrameCounter / GRAIN_CYCLE_FRAMES) % grainTiles.length];
    ctx.filter = "none";
    ctx.globalAlpha = GRAIN_ALPHA;
    ctx.globalCompositeOperation = "overlay";
    ctx.drawImage(tile, x, y, w, h);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
  if (style.overlaySrc) {
    const img = styleOverlayImages[style.overlaySrc];
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.filter = "none";
      // Stretched to exactly match the destination rect -- the overlay
      // asset is already composed with a clear center at its own aspect
      // ratio, so this simply scales the whole decorated border to fit.
      ctx.drawImage(img, x, y, w, h);
    }
  }
}
// -------------------------------------------------------------------------

// --- Photo strip + auto-save --------------------------------------------
const STRIP_SLOT_COUNT = 4;

// Strip proportions, all expressed as multiples of one square slot's
// size -- matches a classic photobooth strip: square photos, thin
// side/top margins, thin gaps between photos, and a noticeably bigger
// bottom margin (the strip's "tail"). The on-screen strip (PhotoStrip.
// layout(), in CSS px keyed off window.innerHeight so it exactly spans
// top to bottom) and the composed download image (composeStripImage,
// in a fixed pixel resolution) both derive their spacing from these same
// ratios, so the two stay visually consistent.
const STRIP_SIDE_MARGIN_RATIO = 0.12;
const STRIP_TOP_MARGIN_RATIO = 0.12;
const STRIP_GAP_RATIO = 0.1;
const STRIP_BOTTOM_MARGIN_RATIO = 0.35;

const STRIP_COMPOSE_SLOT_SIZE = 480; // px -- square, both on-screen and here
const STRIP_COMPOSE_BG = "#f5f0e6";
const STRIP_COMPOSE_BORDER = "#d9d0ba";
const STRIP_COMPOSE_BORDER_WIDTH = 3;
// -------------------------------------------------------------------------

const Webcam = {
  stream: null,
  videoEl: null,

  async init() {
    this.videoEl = document.getElementById("webcam-video");
    setStatus("webcam-status", "webcam: requesting...", null);

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      });
      this.videoEl.srcObject = this.stream;
      setStatus("webcam-status", "webcam: live", "ok");
      return true;
    } catch (err) {
      setStatus("webcam-status", "webcam: denied", "error");
      console.error("Webcam permission error:", err);
      return false;
    }
  },
};

// Transparent overlay canvas the viewfinder frame + vintage crop render
// onto, sized to match the viewport (DPR-aware).
const Canvas = {
  canvas: null,
  ctx: null,
  width: 0,
  height: 0,
  dpr: 1,

  init() {
    this.canvas = document.getElementById("effects-canvas");
    this.ctx = this.canvas.getContext("2d");
    this.resize();
    window.addEventListener("resize", () => this.resize());
  },

  resize() {
    this.dpr = window.devicePixelRatio || 1;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = this.width * this.dpr;
    this.canvas.height = this.height * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  },

  clear() {
    this.ctx.clearRect(0, 0, this.width, this.height);
  },
};

const HandTracker = {
  landmarker: null,
  lastVideoTime: -1,
  _lastResult: [],

  async init() {
    try {
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);
      this.landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: MAX_HANDS,
        // Nudged down from MediaPipe's 0.5 defaults so both hands are
        // detected sooner and tracked through brief motion blur/occlusion
        // instead of dropping out -- the whole frame gesture depends on
        // both hands staying tracked simultaneously.
        minHandDetectionConfidence: 0.4,
        minHandPresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
      });
      setStatus("hand-status", "hand: ready", "ok");
      return true;
    } catch (err) {
      setStatus("hand-status", "hand: failed", "error");
      console.error("HandLandmarker init error:", err);
      return false;
    }
  },

  // Returns an array of hands (each 21 landmarks) detected in the most
  // recent new video frame, alongside their left/right handedness. Returns
  // the cached previous result if the video hasn't advanced to a new frame
  // since the last call.
  detect(videoEl, nowMs) {
    if (!this.landmarker || videoEl.readyState < 2 || !videoEl.videoWidth) return this._lastResult;
    if (videoEl.currentTime === this.lastVideoTime) return this._lastResult;
    this.lastVideoTime = videoEl.currentTime;

    const result = this.landmarker.detectForVideo(videoEl, nowMs);
    if (!result.landmarks || result.landmarks.length === 0) {
      setStatus("hand-status", "hand: no hands", null);
      this._lastResult = [];
      return this._lastResult;
    }

    setStatus("hand-status", `hand: ${result.landmarks.length} detected`, "ok");
    this._lastResult = result.landmarks.map((landmarks, i) => ({
      landmarks,
      handedness: resolveHandedness(result.handednesses[i]?.[0]?.categoryName),
    }));
    return this._lastResult;
  },
};

// Persistent EMA state for the 4 frame corner points (right thumb, right
// index, left thumb, left index), in canvas space. Reset to null whenever
// both hands aren't detected, so the next time they are, the rectangle
// snaps straight to the raw position instead of smoothing in from a
// stale/far-away spot.
const FrameSmoothingState = {
  points: null,
};

function smoothPoint(prev, raw, alpha) {
  return {
    x: prev.x + (raw.x - prev.x) * alpha,
    y: prev.y + (raw.y - prev.y) * alpha,
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// --- Capture flow state machine -----------------------------------------
// phase: "idle" (rectangle live-updates from hand positions) ->
// "countdown" (rectangle locked, counting down) -> "flash" (brief shutter
// flash right after capture) -> back to "idle".
const CaptureState = {
  phase: "idle",
  lockedRect: null, // { x, y, w, h } in canvas space, frozen for the whole countdown
  countdownStartMs: null,
  flashStartMs: null,
  pinchStartMs: null, // when the current continuous pinch began, or null if not currently pinching
};

// In-memory captured photos -- { canvas, dataUrl, width, height, timestamp }.
const capturedPhotos = [];

// Same distance-in-video-pixel-space approach as condensate's pinch
// detection: thumb (4) and index (8) tip coming within the enter/exit
// threshold of each other, on the RIGHT hand only.
function isPinching(hand, videoW, videoH, wasPinching) {
  const thumb = hand.landmarks[THUMB_TIP];
  const index = hand.landmarks[INDEX_TIP];
  const dxPx = (thumb.x - index.x) * videoW;
  const dyPx = (thumb.y - index.y) * videoH;
  const distPx = Math.hypot(dxPx, dyPx);
  return distPx <= (wasPinching ? PINCH_EXIT_THRESHOLD_PX : PINCH_ENTER_THRESHOLD_PX);
}

// Midpoint between thumb and index tip, in normalized video coordinates --
// where the pinch-hold progress ring gets drawn.
function pinchMidpoint(hand) {
  const thumb = hand.landmarks[THUMB_TIP];
  const index = hand.landmarks[INDEX_TIP];
  return { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };
}

function startCountdown(x, y, w, h, nowMs) {
  CaptureState.phase = "countdown";
  CaptureState.lockedRect = { x, y, w, h };
  CaptureState.countdownStartMs = nowMs;
}
// -------------------------------------------------------------------------

// MediaPipe's handedness classifier assumes a mirrored (selfie-style) input
// image — its "Left"/"Right" label is backwards unless the frame fed to it
// was pre-flipped. We feed the raw, unmirrored video frame (only the
// *display* is mirrored, via CSS transform on #webcam-video), so the raw
// label is the opposite of what the user would call their own hand — swap
// it here, once, so everything downstream already sees handedness the way
// the user would describe it themselves.
function resolveHandedness(rawLabel) {
  if (rawLabel === "Left") return "Right";
  if (rawLabel === "Right") return "Left";
  return "unknown";
}

// Maps a normalized point in the *video's own frame* to a mirrored pixel
// position on the full-screen canvas, accounting for the object-fit: cover
// crop the video undergoes (its native aspect ratio may differ from the
// canvas/viewport's) and the mirroring applied to the video via CSS.
function mapVideoToCanvas(nx, ny, videoW, videoH, canvasW, canvasH) {
  const scale = Math.max(canvasW / videoW, canvasH / videoH);
  const dispW = videoW * scale;
  const dispH = videoH * scale;
  const offsetX = (canvasW - dispW) / 2;
  const offsetY = (canvasH - dispH) / 2;
  const screenX = offsetX + nx * dispW;
  const screenY = offsetY + ny * dispH;
  return { x: canvasW - screenX, y: screenY };
}

// The inverse of mapVideoToCanvas: given a point in canvas/screen pixel
// space, returns the corresponding point in the *video's own* pixel space
// (not normalized) -- used to find which part of the raw video frame to
// crop for the vintage preview, so it lines up exactly with where the
// live viewfinder rectangle is drawn on screen.
function mapCanvasToVideo(sx, sy, videoW, videoH, canvasW, canvasH) {
  const scale = Math.max(canvasW / videoW, canvasH / videoH);
  const dispW = videoW * scale;
  const dispH = videoH * scale;
  const offsetX = (canvasW - dispW) / 2;
  const offsetY = (canvasH - dispH) / 2;
  const unmirroredX = canvasW - sx;
  const nx = (unmirroredX - offsetX) / dispW;
  const ny = (sy - offsetY) / dispH;
  return { x: nx * videoW, y: ny * videoH };
}

// --- Precomputed (once, not per-frame) film grain tiles -----------------
function createGrainTile(size) {
  const off = document.createElement("canvas");
  off.width = size;
  off.height = size;
  const octx = off.getContext("2d");
  const imgData = octx.createImageData(size, size);
  for (let i = 0; i < imgData.data.length; i += 4) {
    const v = 128 + (Math.random() * 2 - 1) * 90;
    imgData.data[i] = v;
    imgData.data[i + 1] = v;
    imgData.data[i + 2] = v;
    imgData.data[i + 3] = 255;
  }
  octx.putImageData(imgData, 0, 0);
  return off;
}

let grainTiles = [];
function initGrain() {
  grainTiles = [];
  for (let i = 0; i < GRAIN_TILE_COUNT; i++) grainTiles.push(createGrainTile(GRAIN_TILE_SIZE));
}
// -------------------------------------------------------------------------

// Draws the glowing camera-viewfinder-style frame outline (2 passes: a
// soft wide glow, then a crisp thin core), NOT clipped -- drawn after the
// vintage crop so the glow can bleed slightly outside the rect edge.
function drawFrameOutline(x, y, w, h) {
  const ctx = Canvas.ctx;
  ctx.save();
  ctx.strokeStyle = FRAME_COLOR;
  ctx.shadowColor = FRAME_COLOR;

  ctx.globalAlpha = FRAME_GLOW_ALPHA;
  ctx.shadowBlur = FRAME_GLOW_BLUR;
  ctx.lineWidth = FRAME_GLOW_WIDTH;
  ctx.strokeRect(x, y, w, h);

  ctx.globalAlpha = 1;
  ctx.shadowBlur = 4;
  ctx.lineWidth = FRAME_CORE_WIDTH;
  ctx.strokeRect(x, y, w, h);

  ctx.restore();
}

// Draws a dashed square guide, centered inside the given rectangle, at the
// size the strip's "cover" crop will actually keep (a square of side
// min(w, h) -- see drawStripSlotImage). Skipped once the rectangle is
// already square, since the guide would just retrace the main frame's own
// edges.
function drawStripCropGuide(x, y, w, h) {
  if (Math.abs(w - h) < 1) return;
  const side = Math.min(w, h);
  const gx = x + (w - side) / 2;
  const gy = y + (h - side) / 2;

  const ctx = Canvas.ctx;
  ctx.save();
  ctx.strokeStyle = STRIP_GUIDE_COLOR;
  ctx.globalAlpha = STRIP_GUIDE_ALPHA;
  ctx.lineWidth = STRIP_GUIDE_LINE_WIDTH;
  ctx.setLineDash(STRIP_GUIDE_DASH);
  ctx.strokeRect(gx, gy, side, side);
  ctx.setLineDash([]);

  ctx.globalAlpha = 0.9;
  ctx.fillStyle = STRIP_GUIDE_COLOR;
  ctx.font = `600 ${Math.max(10, Math.min(14, side * 0.06))}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.textBaseline = "top";
  ctx.fillText("strip crop", gx + 6, gy + 6);
  ctx.restore();
}

const PINCH_PROGRESS_RADIUS = 20;
const PINCH_PROGRESS_COLOR = "rgb(255, 214, 130)";

// Small radial progress ring centered on the pinch point while a hold is in
// progress -- gives feedback that the pinch is registering and roughly how
// much longer it needs to be held, instead of silence until it suddenly
// fires at the 1-second mark.
function drawPinchHoldProgress(canvasPoint, progress) {
  const ctx = Canvas.ctx;
  ctx.save();
  ctx.translate(canvasPoint.x, canvasPoint.y);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, PINCH_PROGRESS_RADIUS, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = PINCH_PROGRESS_COLOR;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(0, 0, PINCH_PROGRESS_RADIUS, -Math.PI / 2, -Math.PI / 2 + clamp(progress, 0, 1) * Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}

let grainFrameCounter = 0;

// Draws the active style's preview INSIDE the given canvas-space rectangle
// only (clipped), by cropping the matching region straight out of the live
// video, then the glowing frame outline around it. Outside the rectangle,
// the canvas stays untouched/transparent, so the normal color video shows
// through unaffected.
function drawStyledFrame(rectX, rectY, rectW, rectH, video, videoW, videoH) {
  if (rectW < MIN_FRAME_SIZE || rectH < MIN_FRAME_SIZE) return;
  const ctx = Canvas.ctx;
  const style = STYLES[StyleState.index];

  // Find the matching source rectangle in the video's own pixel space
  // (mapCanvasToVideo already accounts for the mirror, so a plain bounding
  // box of the two mapped corners gives the correct crop).
  const c1 = mapCanvasToVideo(rectX, rectY, videoW, videoH, Canvas.width, Canvas.height);
  const c2 = mapCanvasToVideo(rectX + rectW, rectY + rectH, videoW, videoH, Canvas.width, Canvas.height);
  const srcX = Math.min(c1.x, c2.x);
  const srcY = Math.min(c1.y, c2.y);
  const srcW = Math.max(1, Math.abs(c2.x - c1.x));
  const srcH = Math.max(1, Math.abs(c2.y - c1.y));

  ctx.save();
  ctx.beginPath();
  ctx.rect(rectX, rectY, rectW, rectH);
  ctx.clip();

  // The background <video> is mirrored via CSS; this crop is drawn fresh
  // from the raw (unmirrored) source, so it needs its own horizontal flip
  // -- scoped to just this draw -- to match that mirrored orientation.
  ctx.save();
  ctx.translate(rectX + rectW, rectY);
  ctx.scale(-1, 1);
  ctx.filter = style.filter;
  ctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, rectW, rectH);
  ctx.restore();

  // Grain / decorative overlay, still within the same clip.
  drawStylePostProcessing(ctx, style, rectX, rectY, rectW, rectH);

  ctx.restore();

  drawFrameOutline(rectX, rectY, rectW, rectH);
  drawStripCropGuide(rectX, rectY, rectW, rectH);
}

// Draws the large "4-3-2-1" countdown number centered in the (locked)
// rectangle, with a quick scale-in "pop" at the start of each second so
// it feels alive rather than just ticking over flatly.
function drawCountdownNumber(x, y, w, h, nowMs) {
  const elapsedS = (nowMs - CaptureState.countdownStartMs) / 1000;
  const secondIndex = Math.min(COUNTDOWN_SECONDS - 1, Math.floor(elapsedS));
  const number = COUNTDOWN_SECONDS - secondIndex;
  const fracIntoSecond = elapsedS - secondIndex;
  const pop = fracIntoSecond < COUNTDOWN_POP_DURATION_S ? 1 - fracIntoSecond / COUNTDOWN_POP_DURATION_S : 0;
  const scale = 1 + pop * 0.4;

  const ctx = Canvas.ctx;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const fontSize = Math.min(w, h) * 0.5;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
  ctx.shadowBlur = 20;
  ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
  ctx.fillText(String(number), 0, 0);
  ctx.restore();
}

// Full-screen white flash, fading out linearly over FLASH_DURATION_MS --
// the shutter feedback moment.
function drawFlash(elapsedMs) {
  const alpha = 1 - clamp(elapsedMs / FLASH_DURATION_MS, 0, 1);
  if (alpha <= 0) return;
  const ctx = Canvas.ctx;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, Canvas.width, Canvas.height);
  ctx.restore();
}

// Logs a captured photo to the console: dimensions/count as text, plus an
// inline thumbnail preview (a DevTools trick: a zero-content log styled
// with a background-image at the photo's own size) so we can actually SEE
// what got captured before the photo-strip UI exists.
function logCapturedPhoto(photo) {
  console.log(`[photobooth] captured photo #${capturedPhotos.length} — ${photo.width}x${photo.height}`);
  console.log(
    "%c ",
    `font-size: 1px; padding: ${Math.round(photo.height / 2)}px ${Math.round(photo.width / 2)}px; ` +
      `background: url(${photo.dataUrl}) no-repeat; background-size: ${photo.width}px ${photo.height}px; ` +
      `border: 1px solid #888;`
  );
}

// Crops the *raw* video to the locked rectangle's bounds (same source-rect
// math as the live preview), renders it to its own small canvas at the
// rectangle's own pixel size with the same vintage filter + grain, and
// stores it in `capturedPhotos`.
function capturePhoto(video, videoW, videoH, rectX, rectY, rectW, rectH) {
  // Whatever style is active right now -- at the moment the countdown
  // actually reaches zero -- is what gets baked in, so cycling styles
  // during the countdown (if the user changes their mind) still applies.
  const style = STYLES[StyleState.index];

  const c1 = mapCanvasToVideo(rectX, rectY, videoW, videoH, Canvas.width, Canvas.height);
  const c2 = mapCanvasToVideo(rectX + rectW, rectY + rectH, videoW, videoH, Canvas.width, Canvas.height);
  const srcX = Math.min(c1.x, c2.x);
  const srcY = Math.min(c1.y, c2.y);
  const srcW = Math.max(1, Math.abs(c2.x - c1.x));
  const srcH = Math.max(1, Math.abs(c2.y - c1.y));

  const outW = Math.max(1, Math.round(rectW));
  const outH = Math.max(1, Math.round(rectH));
  const photoCanvas = document.createElement("canvas");
  photoCanvas.width = outW;
  photoCanvas.height = outH;
  const pctx = photoCanvas.getContext("2d");

  pctx.save();
  pctx.translate(outW, 0);
  pctx.scale(-1, 1);
  pctx.filter = style.filter;
  pctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, outW, outH);
  pctx.restore();

  drawStylePostProcessing(pctx, style, 0, 0, outW, outH);

  const photo = {
    canvas: photoCanvas,
    dataUrl: photoCanvas.toDataURL("image/png"),
    width: outW,
    height: outH,
    timestamp: Date.now(),
    styleName: style.name,
  };
  capturedPhotos.push(photo);
  logCapturedPhoto(photo);
  PhotoStrip.addPhoto(photo);
  return photo;
}

// --- Photo strip UI ------------------------------------------------------
// Owns its own round-scoped array of up to STRIP_SLOT_COUNT photos,
// independent of the full historical `capturedPhotos` log -- so a strip
// reset doesn't touch the console-log history, and a fresh round always
// starts from a clean slate regardless of how many photos have ever been
// taken.
const PhotoStrip = {
  slotEls: [],
  photos: [],
  containerEl: null,

  init() {
    this.containerEl = document.getElementById("photo-strip");
    for (let i = 0; i < STRIP_SLOT_COUNT; i++) {
      const slot = document.createElement("div");
      this.containerEl.appendChild(slot);
      this.slotEls.push(slot);
      this._renderEmptySlot(i);
    }
    this.layout();
    window.addEventListener("resize", () => this.layout());
  },

  // Computes slot size + all margins/gaps from window.innerHeight (see
  // the STRIP_*_RATIO constants above) and sets them as CSS custom
  // properties, so the strip's CSS always exactly spans top to bottom
  // with square slots, at any viewport size.
  layout() {
    const totalRatioUnits =
      STRIP_TOP_MARGIN_RATIO + STRIP_SLOT_COUNT + STRIP_GAP_RATIO * (STRIP_SLOT_COUNT - 1) + STRIP_BOTTOM_MARGIN_RATIO;
    const slotSize = window.innerHeight / totalRatioUnits;
    const sideMargin = slotSize * STRIP_SIDE_MARGIN_RATIO;
    const topMargin = slotSize * STRIP_TOP_MARGIN_RATIO;
    const gap = slotSize * STRIP_GAP_RATIO;
    const bottomMargin = slotSize * STRIP_BOTTOM_MARGIN_RATIO;
    const width = slotSize + sideMargin * 2;

    // Set on the root element (not just the strip container) so other UI
    // -- like #status-bar -- can also read --strip-width to avoid
    // overlapping the strip, via normal CSS custom-property inheritance.
    const style = document.documentElement.style;
    style.setProperty("--strip-slot-size", `${slotSize}px`);
    style.setProperty("--strip-side-margin", `${sideMargin}px`);
    style.setProperty("--strip-top-margin", `${topMargin}px`);
    style.setProperty("--strip-bottom-margin", `${bottomMargin}px`);
    style.setProperty("--strip-gap", `${gap}px`);
    style.setProperty("--strip-width", `${width}px`);
  },

  _renderEmptySlot(index) {
    const slot = this.slotEls[index];
    slot.className = "strip-slot empty";
    slot.innerHTML = "";
    const num = document.createElement("span");
    num.className = "slot-number";
    num.textContent = String(index + 1);
    slot.appendChild(num);
  },

  addPhoto(photo) {
    if (this.photos.length >= STRIP_SLOT_COUNT) return;
    const slot = this.slotEls[this.photos.length];
    this.photos.push(photo);

    slot.className = "strip-slot";
    slot.innerHTML = "";
    const img = document.createElement("img");
    img.src = photo.dataUrl;
    slot.appendChild(img);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "slot-save-btn";
    saveBtn.title = "Save this photo at a custom size";
    saveBtn.textContent = "⤓"; // downwards arrow to bar
    saveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      SizePicker.open(photo);
    });
    slot.appendChild(saveBtn);

    if (this.photos.length === STRIP_SLOT_COUNT) {
      // Hand off to the round-complete modal to ask how to save this
      // round, instead of auto-downloading the strip -- it's responsible
      // for calling PhotoStrip.reset() once the user is done.
      RoundCompleteModal.open(this.photos);
    }
  },

  reset() {
    this.photos = [];
    for (let i = 0; i < STRIP_SLOT_COUNT; i++) this._renderEmptySlot(i);
  },
};

// Computes the source rect a "cover"-style fit would keep -- fills the
// whole destination box with no distortion by cropping whichever source
// dimension has the excess, instead of stretching. Shared by the strip
// compositing below and the individual-photo batch save.
function computeCoverCropRect(srcW, srcH, dstW, dstH) {
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  if (srcAspect > dstAspect) {
    const sh = srcH;
    const sw = sh * dstAspect;
    return { sx: (srcW - sw) / 2, sy: 0, sw, sh };
  }
  const sw = srcW;
  const sh = sw / dstAspect;
  return { sx: 0, sy: (srcH - sh) / 2, sw, sh };
}

// Draws one photo into the composed strip canvas, cropped ("cover"-style)
// to the slot's aspect ratio since captured photos can be any aspect
// ratio the user happened to frame.
function drawStripSlotImage(ctx, photo, slotX, slotY, slotW, slotH) {
  const { sx, sy, sw, sh } = computeCoverCropRect(photo.width, photo.height, slotW, slotH);

  ctx.fillStyle = STRIP_COMPOSE_BORDER;
  ctx.fillRect(
    slotX - STRIP_COMPOSE_BORDER_WIDTH,
    slotY - STRIP_COMPOSE_BORDER_WIDTH,
    slotW + STRIP_COMPOSE_BORDER_WIDTH * 2,
    slotH + STRIP_COMPOSE_BORDER_WIDTH * 2
  );
  ctx.drawImage(photo.canvas, sx, sy, sw, sh, slotX, slotY, slotW, slotH);
}

// Cover-crops one photo into a fresh canvas at the exact target size --
// used by the round-complete modal's "save individually" option, for both
// the "square" default and a custom width/height, so a batch of photos
// with different original aspect ratios all come out undistorted.
function cropPhotoToCanvas(photo, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const { sx, sy, sw, sh } = computeCoverCropRect(photo.width, photo.height, width, height);
  ctx.drawImage(photo.canvas, sx, sy, sw, sh, 0, 0, width, height);
  return canvas;
}

// Composes all 4 photos into one vertical strip image, matching the
// on-screen strip's visual style (cream background, thin borders,
// spacing between photos).
function composeStripImage(photos) {
  // Same ratios as the on-screen strip (see PhotoStrip.layout), applied
  // to a fixed square slot size instead of window.innerHeight.
  const slotSize = STRIP_COMPOSE_SLOT_SIZE;
  const sideMargin = slotSize * STRIP_SIDE_MARGIN_RATIO;
  const topMargin = slotSize * STRIP_TOP_MARGIN_RATIO;
  const gap = slotSize * STRIP_GAP_RATIO;
  const bottomMargin = slotSize * STRIP_BOTTOM_MARGIN_RATIO;

  const totalW = slotSize + sideMargin * 2;
  const totalH = topMargin + slotSize * photos.length + gap * (photos.length - 1) + bottomMargin;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(totalW);
  canvas.height = Math.round(totalH);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = STRIP_COMPOSE_BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  photos.forEach((photo, i) => {
    const slotX = sideMargin;
    const slotY = topMargin + i * (slotSize + gap);
    drawStripSlotImage(ctx, photo, slotX, slotY, slotSize, slotSize);
  });

  return canvas;
}

// Triggers a browser download of a canvas as a PNG -- a temporary
// off-DOM <a download> click, the standard client-side technique.
function downloadCanvasAsPng(canvas, filename) {
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, "image/png");
}

function composeAndDownloadStrip(photos) {
  const canvas = composeStripImage(photos);
  downloadCanvasAsPng(canvas, `photobooth-strip-${Date.now()}.png`);
}
// -------------------------------------------------------------------------

// --- Per-photo custom-size save -------------------------------------------
// Opened from the small save button on any filled strip slot. Lets the
// user download that one photo resized to whatever width/height they
// choose -- independent of the strip's fixed square slots -- prefilled
// with the photo's own dimensions, with an optional aspect-ratio lock so
// adjusting one field keeps the other in proportion.
const SizePicker = {
  overlayEl: null,
  previewEl: null,
  widthEl: null,
  heightEl: null,
  lockEl: null,
  photo: null,
  aspectRatio: 1,

  init() {
    this.overlayEl = document.getElementById("size-picker-overlay");
    this.previewEl = document.getElementById("size-picker-preview");
    this.widthEl = document.getElementById("size-picker-width");
    this.heightEl = document.getElementById("size-picker-height");
    this.lockEl = document.getElementById("size-picker-lock");

    this.widthEl.addEventListener("input", () => {
      if (!this.lockEl.checked) return;
      const w = parseInt(this.widthEl.value, 10);
      if (w > 0) this.heightEl.value = Math.max(1, Math.round(w / this.aspectRatio));
    });
    this.heightEl.addEventListener("input", () => {
      if (!this.lockEl.checked) return;
      const h = parseInt(this.heightEl.value, 10);
      if (h > 0) this.widthEl.value = Math.max(1, Math.round(h * this.aspectRatio));
    });

    document.getElementById("size-picker-cancel").addEventListener("click", () => this.close());
    document.getElementById("size-picker-save").addEventListener("click", () => this.save());
    // Click on the dimmed backdrop (not the card itself) also cancels.
    this.overlayEl.addEventListener("click", (e) => {
      if (e.target === this.overlayEl) this.close();
    });
  },

  open(photo) {
    this.photo = photo;
    this.aspectRatio = photo.width / photo.height;
    this.previewEl.src = photo.dataUrl;
    this.widthEl.value = photo.width;
    this.heightEl.value = photo.height;
    this.lockEl.checked = true;
    this.overlayEl.hidden = false;
  },

  close() {
    this.overlayEl.hidden = true;
    this.photo = null;
  },

  save() {
    if (!this.photo) return;
    const width = Math.max(1, parseInt(this.widthEl.value, 10) || this.photo.width);
    const height = Math.max(1, parseInt(this.heightEl.value, 10) || this.photo.height);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(this.photo.canvas, 0, 0, width, height);

    downloadCanvasAsPng(canvas, `photobooth-photo-${this.photo.timestamp}-${width}x${height}.png`);
    this.close();
  },
};
// -------------------------------------------------------------------------

// --- Round-complete save choice --------------------------------------------
// Once all 4 slots fill, the round no longer auto-downloads the strip and
// resets by itself -- this modal asks how to save it: the combined strip
// (as before), each photo individually (square, matching the strip crop,
// or one custom size applied to all 4), or both. `isOpen` gates mainLoop
// so no new capture can start while this is up; closing it is what
// finally resets the round for the next one.
//
// The custom size isn't typed -- it's drawn with the same two-hand
// thumb/index rectangle gesture as the main frame, confirmed with the
// same pinch-and-hold. While drawing, the modal card itself hides so the
// live camera underneath is visible; `pickingSize` tells mainLoop to run
// the gesture-tracking branch instead of freezing entirely.
const ROUND_INDIVIDUAL_STAGGER_MS = 250; // between each of the 4 downloads -- some browsers throttle several fired from one click

const RoundCompleteModal = {
  isOpen: false,
  pickingSize: false,
  overlayEl: null,
  thumbsEl: null,
  squareRadioEl: null,
  customRadioEl: null,
  customFieldsEl: null,
  sizeReadoutEl: null,
  drawSizeBtn: null,
  cancelSizeBtn: null,
  photos: null,
  customWidth: null,
  customHeight: null,
  saveIndividualBtn: null,
  // Gesture-drawing-in-progress state, separate from the main capture
  // flow's CaptureState/FrameSmoothingState so the two never interfere.
  gesturePoints: null,
  gesturePinchStartMs: null,

  init() {
    this.overlayEl = document.getElementById("round-complete-overlay");
    this.thumbsEl = document.getElementById("round-complete-thumbs");
    this.squareRadioEl = document.getElementById("round-size-square");
    this.customRadioEl = document.getElementById("round-size-custom");
    this.customFieldsEl = document.getElementById("round-custom-fields");
    this.sizeReadoutEl = document.getElementById("round-custom-size-readout");
    this.drawSizeBtn = document.getElementById("round-draw-size");
    this.cancelSizeBtn = document.getElementById("size-gesture-cancel");
    this.saveIndividualBtn = document.getElementById("round-save-individual");

    const syncCustomFieldsVisibility = () => {
      this.customFieldsEl.hidden = !this.customRadioEl.checked;
      this._updateSaveButtonState();
    };
    this.squareRadioEl.addEventListener("change", syncCustomFieldsVisibility);
    this.customRadioEl.addEventListener("change", syncCustomFieldsVisibility);

    this.drawSizeBtn.addEventListener("click", () => this.startSizeGesture());
    this.cancelSizeBtn.addEventListener("click", () => this.cancelSizeGesture());

    document.getElementById("round-save-strip").addEventListener("click", () => this.saveStrip());
    this.saveIndividualBtn.addEventListener("click", () => this.saveIndividual());
    document.getElementById("round-done").addEventListener("click", () => this.close());
  },

  // "Save All 4" is disabled whenever "Custom size" is selected but no
  // size has been drawn yet -- Square always has a size (the strip's own
  // slot size), so it's never disabled for that choice.
  _updateSaveButtonState() {
    const needsSize = this.customRadioEl.checked && (!this.customWidth || !this.customHeight);
    this.saveIndividualBtn.disabled = needsSize;
  },

  open(photos) {
    this.photos = photos;
    this.isOpen = true;

    this.thumbsEl.innerHTML = "";
    photos.forEach((photo) => {
      const img = document.createElement("img");
      img.src = photo.dataUrl;
      img.className = "round-thumb";
      this.thumbsEl.appendChild(img);
    });

    this.squareRadioEl.checked = true;
    this.customFieldsEl.hidden = true;
    this.customWidth = null;
    this.customHeight = null;
    this.sizeReadoutEl.textContent = "No size set yet";
    this._updateSaveButtonState();

    this.overlayEl.hidden = false;
  },

  close() {
    this.isOpen = false;
    this.overlayEl.hidden = true;
    this.photos = null;
    PhotoStrip.reset();
  },

  saveStrip() {
    if (!this.photos) return;
    composeAndDownloadStrip(this.photos);
  },

  saveIndividual() {
    if (!this.photos) return;
    const useSquare = this.squareRadioEl.checked;
    if (!useSquare && (!this.customWidth || !this.customHeight)) return; // guarded by disabling the button too
    const width = useSquare ? STRIP_COMPOSE_SLOT_SIZE : this.customWidth;
    const height = useSquare ? STRIP_COMPOSE_SLOT_SIZE : this.customHeight;

    this.photos.forEach((photo, i) => {
      setTimeout(() => {
        const canvas = cropPhotoToCanvas(photo, width, height);
        downloadCanvasAsPng(canvas, `photobooth-photo-${i + 1}-${photo.timestamp}-${width}x${height}.png`);
      }, i * ROUND_INDIVIDUAL_STAGGER_MS);
    });
  },

  // --- Hand-gesture custom size -------------------------------------------
  startSizeGesture() {
    this.pickingSize = true;
    this.gesturePoints = null;
    this.gesturePinchStartMs = null;
    this.overlayEl.hidden = true; // reveal the live camera underneath
    this.cancelSizeBtn.hidden = false;
  },

  cancelSizeGesture() {
    this.pickingSize = false;
    this.cancelSizeBtn.hidden = true;
    this.overlayEl.hidden = false; // bring the modal back, unchanged
  },

  // Called every frame from mainLoop while pickingSize is true. Mirrors
  // the main capture flow's rectangle-forming + pinch-hold-to-confirm
  // gesture, but confirming just records a size instead of starting a
  // countdown.
  updateSizeGesture(nowMs, hands, videoW, videoH) {
    const rightHand = hands.find((h) => h.handedness === "Right") || null;
    const leftHand = hands.find((h) => h.handedness === "Left") || null;

    drawSizeGestureInstructions();

    if (!rightHand || !leftHand) {
      this.gesturePoints = null;
      this.gesturePinchStartMs = null;
      return;
    }

    const rawPoints = [
      rightHand.landmarks[THUMB_TIP],
      rightHand.landmarks[INDEX_TIP],
      leftHand.landmarks[THUMB_TIP],
      leftHand.landmarks[INDEX_TIP],
    ].map((lm) => mapVideoToCanvas(lm.x, lm.y, videoW, videoH, Canvas.width, Canvas.height));

    this.gesturePoints = this.gesturePoints
      ? this.gesturePoints.map((prev, i) => smoothPoint(prev, rawPoints[i], FRAME_SMOOTHING_ALPHA))
      : rawPoints.map((p) => ({ ...p }));
    const points = this.gesturePoints;

    const minX = Math.min(...points.map((p) => p.x));
    const maxX = Math.max(...points.map((p) => p.x));
    const minY = Math.min(...points.map((p) => p.y));
    const maxY = Math.max(...points.map((p) => p.y));
    const rectW = maxX - minX;
    const rectH = maxY - minY;

    drawFrameOutline(minX, minY, rectW, rectH);

    const pinching = isPinching(rightHand, videoW, videoH, this.gesturePinchStartMs !== null);
    if (pinching && rectW >= MIN_FRAME_SIZE && rectH >= MIN_FRAME_SIZE) {
      if (this.gesturePinchStartMs === null) this.gesturePinchStartMs = nowMs;
      const heldMs = nowMs - this.gesturePinchStartMs;
      if (heldMs >= PINCH_HOLD_MS) {
        this._confirmSize(minX, minY, rectW, rectH, videoW, videoH);
      } else {
        const mid = pinchMidpoint(rightHand);
        const midCanvas = mapVideoToCanvas(mid.x, mid.y, videoW, videoH, Canvas.width, Canvas.height);
        drawPinchHoldProgress(midCanvas, heldMs / PINCH_HOLD_MS);
      }
    } else {
      this.gesturePinchStartMs = null;
    }
  },

  // Locks in the drawn rectangle: maps its on-screen corners back to
  // native video-pixel space (same math the actual photo capture uses),
  // so a bigger hand-drawn rectangle means a bigger exported photo,
  // consistently with how framing already works everywhere else here.
  _confirmSize(rectX, rectY, rectW, rectH, videoW, videoH) {
    const c1 = mapCanvasToVideo(rectX, rectY, videoW, videoH, Canvas.width, Canvas.height);
    const c2 = mapCanvasToVideo(rectX + rectW, rectY + rectH, videoW, videoH, Canvas.width, Canvas.height);
    this.customWidth = Math.max(1, Math.round(Math.abs(c2.x - c1.x)));
    this.customHeight = Math.max(1, Math.round(Math.abs(c2.y - c1.y)));
    this.sizeReadoutEl.textContent = `${this.customWidth} × ${this.customHeight}px`;
    this._updateSaveButtonState();

    this.pickingSize = false;
    this.cancelSizeBtn.hidden = true;
    this.overlayEl.hidden = false;
  },
};

// Instruction text + a plain full-screen video/rectangle view while
// drawing a custom size -- no vintage filter here since we're sizing an
// export canvas, not previewing what a photo will look like.
function drawSizeGestureInstructions() {
  const ctx = Canvas.ctx;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = `600 18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.shadowColor = "rgba(0, 0, 0, 0.7)";
  ctx.shadowBlur = 10;
  ctx.fillStyle = "#fff";
  ctx.fillText("Form a rectangle with both hands, then pinch & hold to set this size", Canvas.width / 2, 24);
  ctx.restore();
}
// -------------------------------------------------------------------------

function setStatus(elementId, label, state) {
  const el = document.getElementById(elementId);
  el.textContent = label;
  el.classList.remove("ok", "error");
  if (state) el.classList.add(state);
}

function mainLoop(nowMs) {
  Canvas.clear();
  grainFrameCounter++;

  const video = Webcam.videoEl;
  const hands = video && video.readyState >= 2 && video.videoWidth ? HandTracker.detect(video, nowMs) : [];
  const videoW = video?.videoWidth || 0;
  const videoH = video?.videoHeight || 0;

  if (RoundCompleteModal.isOpen) {
    // While drawing a custom size with your hands, the modal card is
    // hidden and this runs the rectangle-forming + pinch-hold gesture
    // instead; otherwise (modal card showing, or between captures)
    // there's nothing to track/draw and no new capture should be able to
    // start until the round is finalized.
    if (RoundCompleteModal.pickingSize) {
      RoundCompleteModal.updateSizeGesture(nowMs, hands, videoW, videoH);
    }
    requestAnimationFrame(mainLoop);
    return;
  }

  const rightHand = hands.find((h) => h.handedness === "Right") || null;
  const leftHand = hands.find((h) => h.handedness === "Left") || null;

  if (CaptureState.phase === "idle") {
    if (rightHand && leftHand) {
      const rawPoints = [
        rightHand.landmarks[THUMB_TIP],
        rightHand.landmarks[INDEX_TIP],
        leftHand.landmarks[THUMB_TIP],
        leftHand.landmarks[INDEX_TIP],
      ].map((lm) => mapVideoToCanvas(lm.x, lm.y, videoW, videoH, Canvas.width, Canvas.height));

      FrameSmoothingState.points = FrameSmoothingState.points
        ? FrameSmoothingState.points.map((prev, i) => smoothPoint(prev, rawPoints[i], FRAME_SMOOTHING_ALPHA))
        : rawPoints.map((p) => ({ ...p }));
      const points = FrameSmoothingState.points;

      const minX = Math.min(...points.map((p) => p.x));
      const maxX = Math.max(...points.map((p) => p.x));
      const minY = Math.min(...points.map((p) => p.y));
      const maxY = Math.max(...points.map((p) => p.y));
      const rectW = maxX - minX;
      const rectH = maxY - minY;

      drawStyledFrame(minX, minY, rectW, rectH, video, videoW, videoH);

      // The pinch has to be HELD continuously for PINCH_HOLD_MS before it
      // triggers the countdown -- a single close-enough frame isn't
      // enough, so a brief accidental thumb/index graze during normal
      // hand motion can't fire a capture by itself.
      const pinching = isPinching(rightHand, videoW, videoH, CaptureState.pinchStartMs !== null);
      if (pinching && rectW >= MIN_FRAME_SIZE && rectH >= MIN_FRAME_SIZE) {
        if (CaptureState.pinchStartMs === null) CaptureState.pinchStartMs = nowMs;
        const heldMs = nowMs - CaptureState.pinchStartMs;
        if (heldMs >= PINCH_HOLD_MS) {
          startCountdown(minX, minY, rectW, rectH, nowMs);
          CaptureState.pinchStartMs = null;
        } else {
          const mid = pinchMidpoint(rightHand);
          const midCanvas = mapVideoToCanvas(mid.x, mid.y, videoW, videoH, Canvas.width, Canvas.height);
          drawPinchHoldProgress(midCanvas, heldMs / PINCH_HOLD_MS);
        }
      } else {
        // Any break -- fingers moving apart, or the rectangle not being
        // big enough yet -- resets the hold; it has to be one continuous
        // pinch, not several short ones added together.
        CaptureState.pinchStartMs = null;
      }

      // Left-hand pinch cycles the style -- single-trigger on the rising
      // edge (not held), the opposite of the right hand's pinch-and-hold,
      // so the two gestures can't be mistaken for each other and track
      // fully independently (separate hand, separate state, separate
      // trigger condition).
      const leftPinching = isPinching(leftHand, videoW, videoH, StyleState.leftWasPinching);
      if (leftPinching && !StyleState.leftWasPinching) {
        cycleStyle();
      }
      StyleState.leftWasPinching = leftPinching;
    } else {
      // Reset so the rectangle snaps to the raw position next time both
      // hands appear, instead of smoothing in from wherever it was left.
      FrameSmoothingState.points = null;
      CaptureState.pinchStartMs = null;
      StyleState.leftWasPinching = false;
    }
  } else if (CaptureState.phase === "countdown") {
    // Locked: geometry is frozen, but the video feed inside it stays
    // live -- hands are free to move or leave frame entirely.
    const { x, y, w, h } = CaptureState.lockedRect;
    drawStyledFrame(x, y, w, h, video, videoW, videoH);
    drawCountdownNumber(x, y, w, h, nowMs);

    if (nowMs - CaptureState.countdownStartMs >= COUNTDOWN_SECONDS * 1000) {
      capturePhoto(video, videoW, videoH, x, y, w, h);
      CaptureState.phase = "flash";
      CaptureState.flashStartMs = nowMs;
    }
  } else if (CaptureState.phase === "flash") {
    const { x, y, w, h } = CaptureState.lockedRect;
    drawStyledFrame(x, y, w, h, video, videoW, videoH);
    drawFlash(nowMs - CaptureState.flashStartMs);

    if (nowMs - CaptureState.flashStartMs >= FLASH_DURATION_MS) {
      CaptureState.phase = "idle";
      CaptureState.lockedRect = null;
      // pinchStartMs is untouched by countdown/flash (only the idle branch
      // reads/writes it), so even if the original pinch is still being
      // held through the whole cycle, the next idle frame starts timing a
      // brand new hold from scratch -- it can't immediately re-trigger.
    }
  }

  requestAnimationFrame(mainLoop);
}

async function init() {
  Canvas.init();
  initGrain();
  preloadStyleOverlays();
  updateStyleLabel();
  PhotoStrip.init();
  SizePicker.init();
  RoundCompleteModal.init();
  await Promise.all([Webcam.init(), HandTracker.init()]);
  requestAnimationFrame(mainLoop);
}

init();
