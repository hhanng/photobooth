import {
  FilesetResolver,
  HandLandmarker,
  FaceLandmarker,
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

// --- Face tracking -----------------------------------------------------
// A second, independent MediaPipe landmarker running alongside
// HandLandmarker (same video frame, its own detectForVideo call) --
// drives the face-based beauty filters (skin smoother, blush) below,
// across every face currently in frame, entirely independent of the
// hand-formed capture rectangle.
const FACE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const MAX_FACES = 4;
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
    name: "No Filter",
    // The genuinely raw, unedited feed -- no color/contrast adjustment, no
    // grain, no overlay -- so there's always a true "what the camera
    // actually sees" option in the cycle, not just the least-processed of
    // the stylized looks.
    filter: "none",
    grain: false,
    overlaySrc: null,
  },
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

// (Face-based beauty filters -- skin smoother + blush -- live further
// down, near the face-tracking/rendering code they depend on; see
// "Face beauty filters" below.)

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

// Sizing the strip purely off window.innerHeight (below) looks right on a
// wide/short desktop window, but on a narrow/tall phone screen it would
// blow up to well over half the viewport's *width* -- crowding out the
// pattern-picker column and leaving no room in the middle to actually
// form the two-hand frame gesture. Capping it to a fraction of the
// viewport width too, and letting whichever constraint is tighter win,
// keeps it a sensible size on any screen. On desktop this ratio is never
// the binding constraint, so nothing changes there.
const STRIP_MAX_WIDTH_RATIO = 0.3;

// The strip's total height, in the same "multiples of one slot" units --
// shared by PhotoStrip.layout() (on-screen, slotSize = window.innerHeight
// / this) and the pattern-tiling setup below (composed image, whose total
// height is always STRIP_COMPOSE_SLOT_SIZE * this, since it's always 4
// fixed-ratio photos).
const STRIP_TOTAL_RATIO_UNITS =
  STRIP_TOP_MARGIN_RATIO + STRIP_SLOT_COUNT + STRIP_GAP_RATIO * (STRIP_SLOT_COUNT - 1) + STRIP_BOTTOM_MARGIN_RATIO;

const STRIP_COMPOSE_SLOT_SIZE = 480; // px -- square, both on-screen and here
const STRIP_COMPOSE_BG = "#f5f0e6"; // fallback, used only if the selected pattern image hasn't loaded yet
const STRIP_COMPOSE_BORDER = "#d9d0ba";
const STRIP_COMPOSE_BORDER_WIDTH = 3;

// Small caption baked into every composed/downloaded strip, bottom margin
// area, regardless of which background pattern is selected.
const STRIP_SIGNATURE_TEXT = "/by hhan/";
// -------------------------------------------------------------------------

// --- Strip background patterns -------------------------------------------
// A simple list of pattern image paths -- just append another path here to
// add a new selectable option, no other code changes needed. Whichever one
// is selected fills the strip's background (behind/between the 4 photos),
// tiled rather than stretched so it doesn't look distorted.
const STRIP_PATTERNS = [
  "assets/strip-patterns/red-stripes.png",
  "assets/strip-patterns/blue-stars.png",
  "assets/strip-patterns/pink-watercolor-stars.png",
  "assets/strip-patterns/starry-night.png",
  "assets/strip-patterns/pink-glass-tile.png",
  "assets/strip-patterns/leopard.png",
];
// Plain white, used when no pattern is selected (StripPatternState.index
// === null) -- distinct from STRIP_COMPOSE_BG, which is only a loading
// fallback for when a pattern IS selected but its tile hasn't finished
// rendering yet.
const STRIP_NO_PATTERN_BG = "#ffffff";

// How many times each pattern repeats vertically down the strip's full
// height -- the one knob to retune if a pattern looks too small/busy (too
// many repeats) or too large/loses detail (too few). 2-3 keeps enough of
// the pattern's actual texture/motif visible per repeat instead of
// reducing it to visual noise.
const STRIP_PATTERN_TARGET_REPEATS = 2.5;

// Loaded once at startup, keyed by path -- see preloadStripPatterns().
const stripPatternImages = {}; // path -> full-res Image
const stripPatternTileCanvases = {}; // path -> small canvas pre-scaled per STRIP_PATTERN_TARGET_REPEATS, for ctx.createPattern

function preloadStripPatterns() {
  // The composed strip's total height is fixed (always 4 photos at
  // STRIP_COMPOSE_SLOT_SIZE's ratios), so the target tile height for it
  // can be computed once, up front, rather than per-composition.
  const composedStripHeight = STRIP_COMPOSE_SLOT_SIZE * STRIP_TOTAL_RATIO_UNITS;
  const tileHeight = composedStripHeight / STRIP_PATTERN_TARGET_REPEATS;

  for (const path of STRIP_PATTERNS) {
    const img = new Image();
    img.onload = () => {
      stripPatternTileCanvases[path] = scalePatternForTiling(img, tileHeight);
    };
    img.src = path;
    stripPatternImages[path] = img;
  }
}

// Draws `img` down to a small canvas `targetHeight` tall (aspect-preserved
// width) -- this smaller canvas, not the original full-res image, is what
// gets handed to ctx.createPattern for the composed strip, so each repeat
// actually reads as the intended tile size instead of a native-resolution
// crop of the source. Scaling by height (not width) is what lets
// STRIP_PATTERN_TARGET_REPEATS directly control "how many times down the
// strip" regardless of a pattern's own aspect ratio.
function scalePatternForTiling(img, targetHeight) {
  const aspect = img.naturalWidth / img.naturalHeight;
  const h = Math.max(1, Math.round(targetHeight));
  const w = Math.max(1, Math.round(targetHeight * aspect));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  return canvas;
}

// Which pattern is currently selected -- read fresh by composeStripImage()
// at the moment a strip is actually composed, so changing the selection
// mid-round applies to whichever strip is finished next, not one already
// in progress. index is null when no pattern is selected (plain white
// background) -- see PatternPicker.select()'s toggle-off.
const StripPatternState = {
  index: 0,
};

// Reflects the current selection onto the live on-screen strip's CSS
// background (the composed/downloaded image reads StripPatternState.index
// directly in composeStripImage, independent of this). The actual tile
// *size* on screen is set separately, in PhotoStrip.layout(), since it
// has to stay proportional to the strip's own (responsive) slot size.
function updateOnScreenStripPattern() {
  if (StripPatternState.index === null) {
    document.documentElement.style.setProperty("--strip-pattern", STRIP_NO_PATTERN_BG);
    return;
  }
  const path = STRIP_PATTERNS[StripPatternState.index];
  document.documentElement.style.setProperty("--strip-pattern", `url("${path}")`);
}
// -------------------------------------------------------------------------

// --- Mobile/tablet detection ----------------------------------------------
// Drives whether saving prefers the Web Share API over a direct download
// (see saveCanvasesAsPng) -- the click-to-capture buttons themselves are
// visible on every device now, this no longer gates that. "pointer:
// coarse" matches when the device's PRIMARY input is imprecise (a
// finger, not a mouse/trackpad) -- a touch-capable laptop still reports
// pointer:fine there, since its primary input is the trackpad, which is
// exactly the distinction that matters for save behavior (share sheets
// are a phone/tablet UX, not just "has a touchscreen"). OR'd with a
// plain touch-capability + narrow-viewport check as a fallback for the
// rare browser without pointer-media support. Re-evaluated on resize/
// orientation change, not just once at load, via a body class other
// CSS/JS reads.
const MobileDetect = {
  isMobile: false,

  init() {
    const coarseQuery = window.matchMedia("(pointer: coarse)");
    const update = () => {
      const hasTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
      this.isMobile = coarseQuery.matches || (hasTouch && window.innerWidth <= 900);
      document.body.classList.toggle("mobile-capture", this.isMobile);
    };
    update();
    coarseQuery.addEventListener("change", update);
    window.addEventListener("resize", update);
  },
};
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

// A second, independent landmarker running against the same video element
// -- its own model, its own detectForVideo call, its own last-frame cache
// -- entirely separate from HandTracker so the two never interfere with
// each other. Detects every face currently in frame (up to MAX_FACES),
// not scoped to any hand-formed rectangle.
const FaceTracker = {
  landmarker: null,
  lastVideoTime: -1,
  _lastResult: [],

  async init() {
    try {
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);
      this.landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        numFaces: MAX_FACES,
        // Beauty-filter masking only needs the geometry (eyes/lips/face
        // outline positions) -- blendshapes and the 3D transform matrix
        // are extra output this doesn't use, so both stay off to keep
        // per-frame inference as light as possible.
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      setStatus("face-status", "face: ready", "ok");
      return true;
    } catch (err) {
      setStatus("face-status", "face: failed", "error");
      console.error("FaceLandmarker init error:", err);
      return false;
    }
  },

  // Returns an array of faces (each 478 landmarks) detected in the most
  // recent new video frame. Returns the cached previous result if the
  // video hasn't advanced to a new frame since the last call -- same
  // caching contract as HandTracker.detect, and safe to call more than
  // once per frame (e.g. once from mainLoop, again from capturePhoto)
  // without re-running inference.
  detect(videoEl, nowMs) {
    if (!this.landmarker || videoEl.readyState < 2 || !videoEl.videoWidth) return this._lastResult;
    if (videoEl.currentTime === this.lastVideoTime) return this._lastResult;
    this.lastVideoTime = videoEl.currentTime;

    const result = this.landmarker.detectForVideo(videoEl, nowMs);
    if (!result.faceLandmarks || result.faceLandmarks.length === 0) {
      setStatus("face-status", "face: no faces", null);
      this._lastResult = [];
      return this._lastResult;
    }

    setStatus("face-status", `face: ${result.faceLandmarks.length} detected`, "ok");
    this._lastResult = result.faceLandmarks.map((landmarks) => ({ landmarks }));
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
// flash right after capture) -> back to "idle" (with PhotoPreview opening
// on top to ask Keep/Retake before the photo actually reaches the strip).
const CaptureState = {
  phase: "idle",
  lockedRect: null, // { x, y, w, h } in canvas space, frozen for the whole countdown
  countdownStartMs: null,
  flashStartMs: null,
  pinchStartMs: null, // when the current continuous pinch began, or null if not currently pinching
  pendingPhoto: null, // captured at the end of "flash", handed to PhotoPreview instead of the strip directly
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

// --- Click-to-capture buttons -----------------------------------------
// A centered square, sized off whichever viewport dimension is smaller --
// the same role a hand-formed rectangle plays elsewhere, but fixed and
// always available, since Quick Shot/Countdown Shot (see
// MobileCaptureControls) don't require any hand tracking at all. An easy
// constant to retune if it ends up feeling too tight/loose in practice.
const DEFAULT_CAPTURE_SIZE_RATIO = 0.72;

function defaultCaptureRect() {
  const size = Math.min(Canvas.width, Canvas.height) * DEFAULT_CAPTURE_SIZE_RATIO;
  return {
    x: (Canvas.width - size) / 2,
    y: (Canvas.height - size) / 2,
    w: size,
    h: size,
  };
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
// stores it in `capturedPhotos`. nowMs is only needed to look up the
// (already-detected-this-frame, cached) face landmarks for baking in the
// face beauty filters -- see drawFaceEffectsOnCapture below.
function capturePhoto(video, videoW, videoH, rectX, rectY, rectW, rectH, nowMs) {
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

  // Face beauty filters (skin smoother / blush) -- baked in whenever
  // they're currently toggled on, using whichever faces were detected in
  // this same video frame, remapped from full-video-space into this
  // crop's own local pixel space.
  drawFaceEffectsOnCapture(pctx, video, style, videoW, videoH, srcX, srcY, srcW, srcH, outW, outH, nowMs);

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
  // Not added to the strip yet -- PhotoPreview shows it full-screen first
  // and only calls PhotoStrip.addPhoto() if the user keeps it (explicitly
  // or by letting the preview time out).
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

  // Computes slot size + all margins/gaps from window.innerHeight AND
  // window.innerWidth (see STRIP_*_RATIO / STRIP_MAX_WIDTH_RATIO above)
  // and sets them as CSS custom properties. On a wide/short window the
  // height-driven size wins and the strip spans exactly top to bottom,
  // same as always; on a narrow/tall one the width cap wins instead, so
  // the strip shrinks and (via #photo-strip's own top:50%/translateY
  // CSS) sits vertically centered rather than stretching edge to edge at
  // an unreasonable width.
  layout() {
    const heightSlotSize = window.innerHeight / STRIP_TOTAL_RATIO_UNITS;
    const maxStripWidth = window.innerWidth * STRIP_MAX_WIDTH_RATIO;
    const widthSlotSize = maxStripWidth / (1 + STRIP_SIDE_MARGIN_RATIO * 2);
    const slotSize = Math.min(heightSlotSize, widthSlotSize);

    const sideMargin = slotSize * STRIP_SIDE_MARGIN_RATIO;
    const topMargin = slotSize * STRIP_TOP_MARGIN_RATIO;
    const gap = slotSize * STRIP_GAP_RATIO;
    const bottomMargin = slotSize * STRIP_BOTTOM_MARGIN_RATIO;
    const width = slotSize + sideMargin * 2;
    const height = topMargin + slotSize * STRIP_SLOT_COUNT + gap * (STRIP_SLOT_COUNT - 1) + bottomMargin;

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
    style.setProperty("--strip-height", `${height}px`);
    // Tile size tracks the strip's own actual rendered height (not
    // always window.innerHeight anymore, now that it can be
    // width-capped) so the pattern still reads as the intended 2-3
    // repeats regardless of which constraint won above -- see
    // STRIP_PATTERN_TARGET_REPEATS for what's actually being tuned here.
    style.setProperty("--strip-pattern-tile-size", `${height / STRIP_PATTERN_TARGET_REPEATS}px`);
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

// Fills the whole canvas with the currently-selected strip pattern,
// tiled (not stretched) so the fabric-stripe look doesn't get distorted --
// falls back to the plain cream fill if the image somehow hasn't finished
// loading yet. Read fresh every time a strip is composed, so switching
// patterns mid-round applies to whichever strip finishes next.
function fillStripBackground(ctx, width, height) {
  if (StripPatternState.index === null) {
    ctx.fillStyle = STRIP_NO_PATTERN_BG;
    ctx.fillRect(0, 0, width, height);
    return;
  }
  const path = STRIP_PATTERNS[StripPatternState.index];
  const tile = stripPatternTileCanvases[path];
  if (tile) {
    ctx.fillStyle = ctx.createPattern(tile, "repeat");
  } else {
    ctx.fillStyle = STRIP_COMPOSE_BG;
  }
  ctx.fillRect(0, 0, width, height);
}

// Small studio-style caption baked into the bottom margin band of every
// composed strip, regardless of pattern -- plain black text, subtle size.
function drawStripSignature(ctx, canvasWidth, bottomAreaY, bottomAreaHeight) {
  const fontSize = Math.max(10, Math.round(bottomAreaHeight * 0.16));
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(STRIP_SIGNATURE_TEXT, canvasWidth / 2, bottomAreaY + bottomAreaHeight / 2);
  ctx.restore();
}

// Composes all 4 photos into one vertical strip image, matching the
// on-screen strip's visual style (patterned background, thin borders,
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
  const photosBottomY = topMargin + slotSize * photos.length + gap * (photos.length - 1);
  const totalH = photosBottomY + bottomMargin;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(totalW);
  canvas.height = Math.round(totalH);
  const ctx = canvas.getContext("2d");

  fillStripBackground(ctx, canvas.width, canvas.height);

  photos.forEach((photo, i) => {
    const slotX = sideMargin;
    const slotY = topMargin + i * (slotSize + gap);
    drawStripSlotImage(ctx, photo, slotX, slotY, slotSize, slotSize);
  });

  drawStripSignature(ctx, canvas.width, photosBottomY, bottomMargin);

  return canvas;
}

// Triggers a browser download of a canvas as a PNG -- a temporary
// off-DOM <a download> click, the standard client-side technique. Always
// the desktop save path (untouched by the Web Share stuff below), and
// the mobile fallback when sharing isn't available/doesn't succeed.
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

// --- Save: Web Share API (mobile) with direct-download fallback ---------
// A plain <a download> click on a phone/tablet browser typically lands
// the file in a generic Downloads/Files app almost nobody thinks to
// check, not the actual Photos/gallery app. The Web Share API's native
// share sheet -- with a "Save Image" (or equivalent) action right in it
// -- is what actually gets a photo there. Desktop is untouched: it
// always uses downloadCanvasAsPng directly, same as before this feature,
// since file-share support on desktop browsers is inconsistent and
// downloads there already land somewhere the user expects.
const SAVE_TOAST_DURATION_MS = 3200;

function canvasToBlobAsync(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

let saveToastHideTimeout = null;
function showSaveToast(message) {
  const el = document.getElementById("save-toast");
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(saveToastHideTimeout);
  saveToastHideTimeout = setTimeout(() => {
    el.hidden = true;
  }, SAVE_TOAST_DURATION_MS);
}

// Returns true if the share sheet was actually shown (whether or not the
// user picked something in it -- both count as "handled", so the caller
// doesn't also dump a duplicate direct-download on top). Returns false
// only when sharing isn't available/supported for these files, or the
// attempt itself errored out, so the caller knows to fall back.
async function tryShareFiles(files) {
  if (!navigator.canShare || !navigator.share) return false;
  if (!navigator.canShare({ files })) return false;
  try {
    await navigator.share({ files });
    return true;
  } catch (err) {
    // The user closing the share sheet without picking anything throws
    // AbortError -- that's a normal, deliberate outcome, not a failure to
    // fall back from (that would immediately dump an unwanted duplicate
    // direct-download on someone who simply changed their mind).
    if (err && err.name === "AbortError") return true;
    console.warn("[photobooth] navigator.share failed, falling back to direct download:", err);
    return false;
  }
}

// The one function everything else in this file calls to save an image
// (or several at once -- e.g. "Save All 4" -- as ONE combined share, so
// the OS handles them together in a single native action instead of
// popping up several share sheets back to back). canvases/filenames are
// index-matched, same length. On mobile, tries sharing first; falls back
// to downloadCanvasAsPng for each (staggered, same as before) if sharing
// isn't available/supported/fails -- desktop always goes straight there.
async function saveCanvasesAsPng(canvases, filenames) {
  if (MobileDetect.isMobile) {
    const blobs = await Promise.all(canvases.map(canvasToBlobAsync));
    if (blobs.every(Boolean)) {
      const files = blobs.map((blob, i) => new File([blob], filenames[i], { type: "image/png" }));
      if (await tryShareFiles(files)) return;
    }
  }

  canvases.forEach((canvas, i) => {
    setTimeout(() => downloadCanvasAsPng(canvas, filenames[i]), i * ROUND_INDIVIDUAL_STAGGER_MS);
  });
  if (MobileDetect.isMobile) showSaveToast("Saved to your downloads");
}
// -------------------------------------------------------------------------

function composeAndDownloadStrip(photos) {
  const canvas = composeStripImage(photos);
  saveCanvasesAsPng([canvas], [`photobooth-strip-${Date.now()}.png`]);
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

    saveCanvasesAsPng([canvas], [`photobooth-photo-${this.photo.timestamp}-${width}x${height}.png`]);
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
  stripPreviewEl: null,
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
    this.stripPreviewEl = document.getElementById("round-complete-strip-preview");
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

    // The real composed strip -- pattern, photos, and signature caption --
    // exactly what "Save Strip" would produce, so you see what you're
    // about to get instead of 4 disconnected thumbnails.
    this.stripPreviewEl.src = composeStripImage(photos).toDataURL("image/png");

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

    const canvases = this.photos.map((photo) => cropPhotoToCanvas(photo, width, height));
    const filenames = this.photos.map((photo, i) => `photobooth-photo-${i + 1}-${photo.timestamp}-${width}x${height}.png`);
    saveCanvasesAsPng(canvases, filenames);
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

// --- Shared single-fingertip dwell-to-select gesture ----------------------
// A lightweight "hover to click" gesture used anywhere a button or swatch
// should be selectable without a pinch: either hand's index fingertip
// (landmark 8), held over a target element's live getBoundingClientRect()
// for DWELL_SELECT_MS, counts as a click. Used by the strip-pattern
// swatches and the photo-preview Keep/Retake buttons.
const DWELL_SELECT_MS = 500;

function createDwellTracker() {
  return { targetIndex: null, startMs: null };
}

// targets: an array of DOM elements (entries may be null/undefined to
// leave a gap in the index space). Returns { index, progress } for
// whichever target is currently hovered by any hand's index fingertip
// (null if none is). Mutates `tracker` in place; the caller owns its own
// tracker instance and applies whatever visual feedback (a ring, a
// progress bar, a CSS class) fits its own UI.
function updateDwellTracking(tracker, nowMs, hands, videoW, videoH, targets) {
  let hoveredIndex = null;
  for (const hand of hands) {
    if (hoveredIndex !== null) break;
    const tipLm = hand.landmarks[INDEX_TIP];
    const tip = mapVideoToCanvas(tipLm.x, tipLm.y, videoW, videoH, Canvas.width, Canvas.height);
    for (let i = 0; i < targets.length; i++) {
      const el = targets[i];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (tip.x >= rect.left && tip.x <= rect.right && tip.y >= rect.top && tip.y <= rect.bottom) {
        hoveredIndex = i;
        break;
      }
    }
  }

  if (hoveredIndex === null) {
    tracker.targetIndex = null;
    tracker.startMs = null;
    return { index: null, progress: 0 };
  }

  if (tracker.targetIndex !== hoveredIndex) {
    tracker.targetIndex = hoveredIndex;
    tracker.startMs = nowMs;
  }
  return { index: hoveredIndex, progress: clamp((nowMs - tracker.startMs) / DWELL_SELECT_MS, 0, 1) };
}
// -------------------------------------------------------------------------

// --- Photo preview + retake ------------------------------------------------
// Shown full-screen immediately after every capture, before the photo is
// committed to the strip -- a last look with a chance to redo it. Letting
// PHOTO_PREVIEW_MS elapse with no explicit choice counts as an implicit
// "Keep", same outcome as clicking/dwelling the Keep button; "Retake"
// discards the photo and returns straight to the live viewfinder with the
// same strip slot left open for another try.
const PHOTO_PREVIEW_MS = 4000;

const PhotoPreview = {
  isOpen: false,
  overlayEl: null,
  imageEl: null,
  retakeBtn: null,
  keepBtn: null,
  photo: null,
  openedAtMs: null,
  dwellTracker: null,

  init() {
    this.overlayEl = document.getElementById("photo-preview-overlay");
    this.imageEl = document.getElementById("photo-preview-image");
    this.retakeBtn = document.getElementById("photo-preview-retake");
    this.keepBtn = document.getElementById("photo-preview-keep");
    this.dwellTracker = createDwellTracker();

    this.retakeBtn.addEventListener("click", () => this.resolve(false));
    this.keepBtn.addEventListener("click", () => this.resolve(true));
  },

  open(photo, nowMs) {
    this.photo = photo;
    this.isOpen = true;
    this.openedAtMs = nowMs;
    this.imageEl.src = photo.dataUrl;
    this.dwellTracker = createDwellTracker();
    this._setDwellProgress(null, 0);
    this.overlayEl.hidden = false;
  },

  // Called every frame from mainLoop while isOpen -- drives both the
  // auto-timeout and the dwell-to-select gesture on either button (mouse
  // clicks are wired separately, in init()).
  update(nowMs, hands, videoW, videoH) {
    const { index, progress } = updateDwellTracking(this.dwellTracker, nowMs, hands, videoW, videoH, [
      this.retakeBtn,
      this.keepBtn,
    ]);
    this._setDwellProgress(index, progress);

    if (index !== null && progress >= 1) {
      this.resolve(index === 1); // 0 = Retake, 1 = Keep
      return;
    }
    if (nowMs - this.openedAtMs >= PHOTO_PREVIEW_MS) {
      this.resolve(true); // elapsed with no action == implicit Keep
    }
  },

  _setDwellProgress(hoveredIndex, progress) {
    this.retakeBtn.style.setProperty("--dwell-progress", hoveredIndex === 0 ? String(progress) : "0");
    this.retakeBtn.classList.toggle("dwelling", hoveredIndex === 0);
    this.keepBtn.style.setProperty("--dwell-progress", hoveredIndex === 1 ? String(progress) : "0");
    this.keepBtn.classList.toggle("dwelling", hoveredIndex === 1);
  },

  resolve(keep) {
    if (!this.isOpen) return;
    const photo = this.photo;
    this.isOpen = false;
    this.photo = null;
    this.overlayEl.hidden = true;
    if (keep) PhotoStrip.addPhoto(photo);
    // Retake: just drop it -- the slot it would have filled stays open.
  },
};
// -------------------------------------------------------------------------

// --- Help ------------------------------------------------------------------
// Opens automatically once on page load, and can be reopened anytime via
// the (?) button -- gates mainLoop the same way the other modals do, so
// nothing can be tracked/triggered underneath it.
const HelpModal = {
  isOpen: false,
  overlayEl: null,

  init() {
    this.overlayEl = document.getElementById("help-overlay");
    document.getElementById("help-button").addEventListener("click", () => this.open());
    document.getElementById("help-close").addEventListener("click", () => this.close());
    // Click on the dimmed backdrop (not the card itself) also closes --
    // safe here since, unlike the round-complete modal, there's nothing
    // this could accidentally discard.
    this.overlayEl.addEventListener("click", (e) => {
      if (e.target === this.overlayEl) this.close();
    });
  },

  open() {
    this.isOpen = true;
    this.overlayEl.hidden = false;
  },

  close() {
    this.isOpen = false;
    this.overlayEl.hidden = true;
  },
};
// -------------------------------------------------------------------------

// --- Strip pattern picker ------------------------------------------------
// A small row of clickable swatches (one per STRIP_PATTERNS entry), built
// dynamically so adding a new pattern later is just appending a path
// above -- no other code changes. Selectable by mouse click, or by either
// hand's index fingertip dwelling on it (the shared DWELL_SELECT_MS
// gesture, same as the photo-preview buttons). Clicking/dwelling the
// already-active swatch again deselects it, reverting the strip
// background to plain white.
const PatternPicker = {
  containerEl: null,
  swatchEls: [],
  ringEls: [],
  dwellTracker: null,

  init() {
    this.containerEl = document.getElementById("pattern-picker");
    this.dwellTracker = createDwellTracker();
    STRIP_PATTERNS.forEach((path, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pattern-swatch";
      btn.title = "Strip background pattern (select again to remove)";
      btn.style.backgroundImage = `url("${path}")`;
      btn.addEventListener("click", () => this.select(i));

      const ring = document.createElement("span");
      ring.className = "pattern-swatch-ring";
      btn.appendChild(ring);

      this.containerEl.appendChild(btn);
      this.swatchEls.push(btn);
      this.ringEls.push(ring);
    });
    this._updateActiveClass();
    updateOnScreenStripPattern();
  },

  // Toggle: selecting the already-active swatch again deselects it (index
  // -> null), instead of just always setting the clicked index.
  select(i) {
    StripPatternState.index = StripPatternState.index === i ? null : i;
    this._updateActiveClass();
    updateOnScreenStripPattern();
  },

  _updateActiveClass() {
    this.swatchEls.forEach((el, i) => el.classList.toggle("active", i === StripPatternState.index));
  },

  // Called every frame, independent of CaptureState.phase -- choosing a
  // strip pattern isn't part of the capture flow, so it works regardless
  // of whether a frame is currently being formed.
  updateDwell(nowMs, hands, videoW, videoH) {
    if (this.swatchEls.length === 0) return;

    const { index: hoveredIndex, progress } = updateDwellTracking(
      this.dwellTracker,
      nowMs,
      hands,
      videoW,
      videoH,
      this.swatchEls
    );

    for (let i = 0; i < this.swatchEls.length; i++) {
      const isHovered = i === hoveredIndex;
      this.swatchEls[i].classList.toggle("dwelling", isHovered);
      this.ringEls[i].style.setProperty("--dwell-progress", isHovered ? String(progress) : "0");
    }

    if (hoveredIndex !== null && progress >= 1) {
      this.select(hoveredIndex);
      this.dwellTracker = createDwellTracker();
    }
  },
};
// -------------------------------------------------------------------------

// --- Face beauty filters (skin smoother + blush) --------------------------
// Two independent on/off toggles. Both live in the viewfinder and get
// baked into the actual saved photo.
const SkinSmootherState = { enabled: false };
const BlushState = { enabled: false };

// --- Skin smoother: gentle whole-frame blur -------------------------------
// A plain soft-focus pass over the ENTIRE frame -- not masked to face
// regions at all. Blends a blurred copy of the whole camera view back
// over the sharp one at low opacity. Deliberately simple: a mask that's
// even slightly too tight or too loose reads as an obvious "filter edge"
// once you're looking for it, where a gentle blur with no edge to notice
// doesn't -- and skin is what visibly benefits from a small blur anyway,
// so eyes/hair/edges just end up a touch softer too, same as a real
// soft-focus lens, rather than needing to be precisely excluded.
const SKIN_SMOOTH_BLUR_PX = 5;
const SKIN_SMOOTH_ALPHA = 0.25;

// CSS filter strings can't just be concatenated with "blur(...)" when the
// base is the literal keyword "none" -- "none blur(5px)" is invalid and
// the whole assignment gets silently ignored by the canvas context, not
// just the "none" part. Swap it out for a bare blur in that case.
function withBlur(filterString, blurPx) {
  const base = filterString === "none" ? "" : `${filterString} `;
  return `${base}blur(${blurPx}px)`;
}

// Live-preview pass: the entire mirrored, cover-fit video (the same
// positioning math the background <video> element itself already uses)
// redrawn blurred and at low opacity over everything drawn so far this
// frame. Not composed with the active style's filter -- this covers the
// WHOLE canvas, including video outside any hand-formed rectangle, which
// stays full-color/unstyled by design (same as the plain background).
function drawSkinSmootherLive(video, videoW, videoH) {
  const ctx = Canvas.ctx;
  const scale = Math.max(Canvas.width / videoW, Canvas.height / videoH);
  const dispW = videoW * scale;
  const dispH = videoH * scale;
  const offsetX = (Canvas.width - dispW) / 2;
  const offsetY = (Canvas.height - dispH) / 2;

  ctx.save();
  ctx.translate(Canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.filter = `blur(${SKIN_SMOOTH_BLUR_PX}px)`;
  ctx.globalAlpha = SKIN_SMOOTH_ALPHA;
  ctx.drawImage(video, 0, 0, videoW, videoH, offsetX, offsetY, dispW, dispH);
  ctx.restore();
}

// Capture-bake version of the same idea, scoped to this photo's own crop
// (srcX/Y/W/H -> destW/destH, the same mirrored-crop recipe capturePhoto's
// sharp draw uses). Unlike the live version, this DOES compose with the
// active style's filter -- the whole captured photo IS the styled crop,
// there's no "outside the frame" region left unstyled the way the live
// canvas has.
function drawSkinSmootherCapture(ctx, video, style, srcX, srcY, srcW, srcH, destW, destH) {
  ctx.save();
  ctx.translate(destW, 0);
  ctx.scale(-1, 1);
  ctx.filter = withBlur(style.filter, SKIN_SMOOTH_BLUR_PX);
  ctx.globalAlpha = SKIN_SMOOTH_ALPHA;
  ctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, destW, destH);
  ctx.restore();
}
// -------------------------------------------------------------------------

// --- Blush: soft radial tint on each detected face's cheeks ---------------
// Built from a small set of well-established, stable FaceLandmarker
// anchor points (face-edge/eye-corner/mouth-corner landmarks used
// ubiquitously across MediaPipe face-mesh tooling), rather than a single
// less-certain "cheek" index -- see blendCheekPoint.
const FACE_LM = {
  LEFT_FACE_EDGE: 234,
  RIGHT_FACE_EDGE: 454,
  LEFT_EYE_OUTER: 33,
  RIGHT_EYE_OUTER: 263,
  MOUTH_LEFT: 61,
  MOUTH_RIGHT: 291,
};

// Shape: a wide, flat, horizontal SWEEP (like a diffused brush stroke
// from under the eye out toward the ear) rather than a round dot -- a
// round blob reads as "drawn on" almost no matter how soft its edge is.
// The actual "shape" drawn is a plain SOLID ellipse -- no gradient at
// all -- with a strong real blur pass doing 100% of the falloff work
// (see drawBlushCheek). A gradient (even a blurred one) still has a
// defined center where color stops changing, which the eye can pick up
// as an edge; a solid fill blurred by a radius on the same order as the
// shape itself has no such plateau -- it's soft diffusion all the way
// through, closer to a point of light blurred into a glow than a shape
// with a soft rim. (An even smaller core blurred by a much larger
// radius reads as *more* edgeless still, but was tuned back up from
// there -- past a point it dilutes the peak alpha so much the result is
// barely visible at all, even compensating with higher opacity.) Both
// the core size and the blur radius scale with face size so it holds
// together at any distance from the camera.
const BLUSH_CORE_RX_RATIO = 0.16; // solid-ellipse half-width before blur, relative to face width -- small on purpose
const BLUSH_CORE_RY_RATIO = 0.07; // half-height -- flat and wide, not round
const BLUSH_BLUR_RATIO = 0.1; // blur radius, relative to face width -- comparable to the core, so blur (not the shape) defines how it reads
const BLUSH_COLOR_RGB = "255, 120, 120"; // warm coral-pink, closer to a natural flush than a cool magenta
// Lower than the old gradient-peak version on purpose -- a blurred,
// diffused fill reads as more intense/spread-out than a sharp shape at
// the same alpha would, so the same "visible flush" needs less of it.
// (Still fairly high in absolute terms because the strong blur dilutes
// the core's own alpha substantially by the time it reaches the skin --
// measured/tuned against real pixel output, not guessed.)
const BLUSH_PEAK_ALPHA = 0.85;
// "soft-light" was tried first (theoretically the more natural of the
// two -- a diffused-light-style blend) but measured/looked too faint
// against real skin-tone values even at high alpha; "multiply" gives a
// clearly visible warm tint at the same alpha while the blur pass (not
// the blend mode) controls the falloff -- canvas compositing still
// respects the source's per-pixel alpha under any blend mode.
const BLUSH_BLEND_MODE = "multiply";

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// One scratch canvas, reused (grown as needed, never shrunk) across every
// cheek/face/frame instead of allocating a fresh canvas per draw --
// avoids per-frame canvas-creation churn while still letting the blur
// radius genuinely scale with each detected face's own size, which a
// single fixed-size cached texture (the previous approach) couldn't do.
let blushScratchCanvas = null;
function getBlushScratchCanvas(minW, minH) {
  if (!blushScratchCanvas) blushScratchCanvas = document.createElement("canvas");
  // Assigning .width/.height always clears the canvas, even to the same
  // value, so only touch them when actually growing.
  if (blushScratchCanvas.width < minW) blushScratchCanvas.width = minW;
  if (blushScratchCanvas.height < minH) blushScratchCanvas.height = minH;
  return blushScratchCanvas;
}

// Maps just the anchor landmarks this module actually uses (not all 478)
// through `mapPoint` -- a closure that already differs between the live
// preview (full-canvas cover-fit mapping) and a capture bake (a specific
// crop's own local mapping), so this same function works for both.
function computeFacePoints(landmarks, mapPoint) {
  const L = FACE_LM;
  const pt = (i) => mapPoint(landmarks[i].x, landmarks[i].y);
  return {
    leftEdge: pt(L.LEFT_FACE_EDGE),
    rightEdge: pt(L.RIGHT_FACE_EDGE),
    leftEyeOuter: pt(L.LEFT_EYE_OUTER),
    rightEyeOuter: pt(L.RIGHT_EYE_OUTER),
    mouthLeft: pt(L.MOUTH_LEFT),
    mouthRight: pt(L.MOUTH_RIGHT),
  };
}

function computeFaceGeometry(p) {
  return {
    faceWidth: dist(p.leftEdge, p.rightEdge),
    leftCheek: blendCheekPoint(p.leftEyeOuter, p.mouthLeft, p.leftEdge),
    rightCheek: blendCheekPoint(p.rightEyeOuter, p.mouthRight, p.rightEdge),
    // The natural "sweep" direction for each cheek -- from the eye's
    // outer corner out toward the face edge, which is roughly how you'd
    // actually drag a blush brush; also naturally mirrors correctly
    // between the left/right cheeks since the two vectors point in
    // opposite x-directions.
    leftCheekAngle: Math.atan2(p.leftEdge.y - p.leftEyeOuter.y, p.leftEdge.x - p.leftEyeOuter.x),
    rightCheekAngle: Math.atan2(p.rightEdge.y - p.rightEyeOuter.y, p.rightEdge.x - p.rightEyeOuter.x),
  };
}

// A natural cheek "apple" position, derived (not a single raw landmark)
// from three high-confidence anchors, weighted mostly toward mouth-corner
// height with the eye-outer corner mainly pulling it up off the jawline --
// moved down twice from an initial eye-weighted version after feedback
// that it sat too high, up into the eye area on a real face.
function blendCheekPoint(eyeOuter, mouthCorner, faceEdge) {
  return {
    x: eyeOuter.x * 0.5 + faceEdge.x * 0.3 + mouthCorner.x * 0.2,
    y: eyeOuter.y * 0.3 + mouthCorner.y * 0.7,
  };
}

// Draws one cheek's blush as a solid ellipse, blurred in its own small,
// undistorted scratch canvas, then composited already-blurred onto the
// main canvas. Blurring on a separate layer first (rather than e.g.
// scaling an ellipse and filtering the fill in place) keeps the blur
// isotropic -- a non-uniform scale transform active during a filtered
// draw would stretch the blur unevenly along with the shape, which can
// leave a directional, edge-like artifact along the more-stretched axis.
// Drawn with the real ctx.ellipse() geometry instead, so no scale
// transform is ever involved and the blur radius means exactly what it
// says in both directions.
function drawBlushCheek(ctx, center, coreRx, coreRy, angle, blurPx) {
  // Generous margin so the blur fades all the way to fully transparent
  // well inside the scratch canvas, never clipped at its edge (a hard
  // clip would reintroduce exactly the kind of visible edge this is
  // trying to avoid). CSS blur(N) is a gaussian with stdDeviation N/2;
  // ~3 standard deviations covers >99% of its visible falloff.
  const pad = blurPx * 3;
  const w = Math.ceil((coreRx + pad) * 2);
  const h = Math.ceil((coreRy + pad) * 2);
  const scratch = getBlushScratchCanvas(w, h);
  const sctx = scratch.getContext("2d");
  sctx.clearRect(0, 0, scratch.width, scratch.height);
  sctx.filter = `blur(${blurPx}px)`;
  sctx.fillStyle = `rgba(${BLUSH_COLOR_RGB}, ${BLUSH_PEAK_ALPHA})`;
  sctx.beginPath();
  sctx.ellipse(w / 2, h / 2, coreRx, coreRy, 0, 0, Math.PI * 2);
  sctx.fill();

  ctx.save();
  ctx.filter = "none";
  ctx.globalCompositeOperation = BLUSH_BLEND_MODE;
  ctx.translate(center.x, center.y);
  ctx.rotate(angle);
  ctx.drawImage(scratch, -w / 2, -h / 2, w, h);
  ctx.restore();
}

function drawFaceBlush(ctx, geo) {
  const coreRx = geo.faceWidth * BLUSH_CORE_RX_RATIO;
  const coreRy = geo.faceWidth * BLUSH_CORE_RY_RATIO;
  const blurPx = geo.faceWidth * BLUSH_BLUR_RATIO;
  drawBlushCheek(ctx, geo.leftCheek, coreRx, coreRy, geo.leftCheekAngle, blurPx);
  drawBlushCheek(ctx, geo.rightCheek, coreRx, coreRy, geo.rightCheekAngle, blurPx);
}
// -------------------------------------------------------------------------

// --- Combined per-frame / per-capture passes -------------------------------
// Live-preview pass: skin smoother (whole frame, no face detection
// needed at all) plus blush (per detected face) -- independent of any
// hand-frame rectangle or CaptureState.phase, called unconditionally from
// mainLoop each frame, same as PatternPicker.updateDwell.
function drawFaceEffects(video, videoW, videoH, faces) {
  if (SkinSmootherState.enabled) drawSkinSmootherLive(video, videoW, videoH);
  // Blush is a warm pink tint -- it only reads as "blush" on the true
  // color feed. Under a desaturating/tinting style (Vintage B&W, Sepia,
  // Star Scrapbook) it either gets stripped right back out or clashes
  // with the style's own color grading, so it's limited to "No Filter".
  if (!BlushState.enabled || STYLES[StyleState.index].filter !== "none") return;

  const ctx = Canvas.ctx;
  const mapPoint = (nx, ny) => mapVideoToCanvas(nx, ny, videoW, videoH, Canvas.width, Canvas.height);
  for (const face of faces) {
    const geo = computeFaceGeometry(computeFacePoints(face.landmarks, mapPoint));
    drawFaceBlush(ctx, geo);
  }
}

// Maps a normalized face-landmark point (video space) into the FINAL,
// already-mirrored local pixel space of a capturePhoto()-style cropped
// canvas -- different math from mapVideoToCanvas (which assumes the
// *whole* video is cover-fit onto a full-size canvas): here a specific
// video-space sub-rectangle (srcX/Y/W/H) is stretched directly to fill
// destW/destH, then mirrored, matching capturePhoto's own draw exactly.
// Only blush needs this now -- the capture smoother works straight off
// srcX/Y/W/H, no per-face remapping.
function mapVideoPointToCroppedCanvas(nx, ny, videoW, videoH, srcX, srcY, srcW, srcH, destW, destH) {
  const videoPxX = nx * videoW;
  const videoPxY = ny * videoH;
  const u = (videoPxX - srcX) / srcW;
  const v = (videoPxY - srcY) / srcH;
  return { x: (1 - u) * destW, y: v * destH };
}

// Capture-bake pass: draws whichever face effects are currently toggled
// on, on top of an already-drawn, already-restored sharp photoCanvas.
function drawFaceEffectsOnCapture(pctx, video, style, videoW, videoH, srcX, srcY, srcW, srcH, destW, destH, nowMs) {
  if (SkinSmootherState.enabled) {
    drawSkinSmootherCapture(pctx, video, style, srcX, srcY, srcW, srcH, destW, destH);
  }
  // Same "No Filter" gate as the live preview (drawFaceEffects) -- keeps
  // the baked photo consistent with what was actually shown on screen.
  if (!BlushState.enabled || style.filter !== "none") return;

  const faces = FaceTracker.detect(video, nowMs);
  if (faces.length === 0) return;

  const mapPoint = (nx, ny) => mapVideoPointToCroppedCanvas(nx, ny, videoW, videoH, srcX, srcY, srcW, srcH, destW, destH);
  for (const face of faces) {
    const geo = computeFaceGeometry(computeFacePoints(face.landmarks, mapPoint));
    drawFaceBlush(pctx, geo);
  }
}
// -------------------------------------------------------------------------

// --- Beauty filter toggle buttons ------------------------------------------
// Two independent, swatch-styled toggle buttons (same visual/interaction
// language as the strip-pattern swatches above: click, or either hand's
// index fingertip dwelling for DWELL_SELECT_MS). Each is a plain boolean
// flip -- select(key) always inverts that filter's own `enabled`, so
// clicking/dwelling an already-active toggle turning it back off is just
// what flipping a boolean does, not a special case to get right (unlike
// the pattern picker's single-select-among-many, where "select the
// active one again" had to be handled explicitly).
const BeautyPicker = {
  buttons: [], // [{ key, el, ringEl }]
  dwellTracker: null,

  init() {
    this.dwellTracker = createDwellTracker();
    this.buttons = [
      { key: "smoother", el: document.getElementById("skin-smoother-toggle") },
      { key: "blush", el: document.getElementById("blush-toggle") },
    ];
    for (const btn of this.buttons) {
      const ring = document.createElement("span");
      ring.className = "pattern-swatch-ring";
      btn.el.appendChild(ring);
      btn.ringEl = ring;
      btn.el.addEventListener("click", () => this.toggle(btn.key));
    }
    this._updateActiveClasses();
  },

  _stateFor(key) {
    return key === "smoother" ? SkinSmootherState : BlushState;
  },

  toggle(key) {
    const state = this._stateFor(key);
    state.enabled = !state.enabled;
    this._updateActiveClasses();
  },

  _updateActiveClasses() {
    for (const btn of this.buttons) {
      const enabled = this._stateFor(btn.key).enabled;
      btn.el.classList.toggle("active", enabled);
      btn.el.setAttribute("aria-pressed", String(enabled));
    }
  },

  // Called every frame, independent of CaptureState.phase -- same as
  // PatternPicker.updateDwell, and tracked with its own separate dwell
  // tracker so hovering a pattern swatch and hovering a beauty toggle
  // can never interfere with each other.
  updateDwell(nowMs, hands, videoW, videoH) {
    const targets = this.buttons.map((b) => b.el);
    const { index: hoveredIndex, progress } = updateDwellTracking(this.dwellTracker, nowMs, hands, videoW, videoH, targets);

    this.buttons.forEach((btn, i) => {
      const isHovered = i === hoveredIndex;
      btn.el.classList.toggle("dwelling", isHovered);
      btn.ringEl.style.setProperty("--dwell-progress", isHovered ? String(progress) : "0");
    });

    if (hoveredIndex !== null && progress >= 1) {
      this.toggle(this.buttons[hoveredIndex].key);
      this.dwellTracker = createDwellTracker();
    }
  },
};
// -------------------------------------------------------------------------

// Whether a brand new capture (hand-gesture, Quick Shot, or Countdown
// Shot) is allowed to start right now -- every modal that should block
// one, plus the capture state machine already being mid-flight. Shared
// by MobileCaptureControls so a tap can't sneak a second capture in
// while one's already in progress or a modal is covering the buttons.
function canStartNewCapture() {
  return (
    !HelpModal.isOpen &&
    !RoundCompleteModal.isOpen &&
    !PhotoPreview.isOpen &&
    CaptureState.phase === "idle"
  );
}

// Two extra buttons, visible on every device, alongside -- not instead
// of -- the two-hand pinch gesture; both work at the same time. Both
// reuse the exact same capture
// state machine the hand gesture drives, just entered by a tap instead of
// a pinch-hold, using defaultCaptureRect() in place of a hand-formed one:
// - Quick Shot skips the countdown entirely, capturing immediately and
//   jumping straight into the existing "flash" phase (still gets the
//   shutter-flash feedback, still hands off to PhotoPreview after).
// - Countdown Shot calls the SAME startCountdown() the pinch-and-hold
//   gesture calls, so the entire "countdown" phase (locked-rect styled
//   preview, the 4-3-2-1 number, auto-capture at zero) is unmodified,
//   shared code.
// Whatever style/beauty-filter toggles are active applies to both, the
// same way it already applies to hand-gesture capture -- capturePhoto()
// itself doesn't know or care how its rect was decided.
const MobileCaptureControls = {
  containerEl: null,
  quickBtn: null,
  countdownBtn: null,

  init() {
    this.containerEl = document.getElementById("mobile-capture-controls");
    this.quickBtn = document.getElementById("quick-shot-btn");
    this.countdownBtn = document.getElementById("countdown-shot-btn");
    this.quickBtn.addEventListener("click", () => this.triggerQuickShot());
    this.countdownBtn.addEventListener("click", () => this.triggerCountdownShot());
  },

  _readyVideo() {
    const video = Webcam.videoEl;
    return video && video.readyState >= 2 && video.videoWidth ? video : null;
  },

  triggerQuickShot() {
    if (!canStartNewCapture()) return;
    const video = this._readyVideo();
    if (!video) return;

    const nowMs = performance.now();
    const rect = defaultCaptureRect();
    CaptureState.lockedRect = rect;
    CaptureState.pendingPhoto = capturePhoto(video, video.videoWidth, video.videoHeight, rect.x, rect.y, rect.w, rect.h, nowMs);
    CaptureState.phase = "flash";
    CaptureState.flashStartMs = nowMs;
  },

  triggerCountdownShot() {
    if (!canStartNewCapture()) return;
    if (!this._readyVideo()) return;

    const rect = defaultCaptureRect();
    startCountdown(rect.x, rect.y, rect.w, rect.h, performance.now());
  },

  // Called every frame from mainLoop. Fully hidden (not just disabled)
  // whenever any modal is open -- including RoundCompleteModal's own
  // pickingSize gesture-drawing sub-state, which hides ITS overlay to
  // reveal the live camera + its own cancel button, so these two rows
  // would otherwise both be visible at once and can sit close enough to
  // collide. Merely disabled (visible but greyed out) during an
  // in-progress countdown/flash, so it's clear the app is mid-capture
  // rather than the buttons having vanished.
  update() {
    const modalOpen = HelpModal.isOpen || RoundCompleteModal.isOpen || PhotoPreview.isOpen;
    this.containerEl.hidden = modalOpen;
    const enabled = !modalOpen && CaptureState.phase === "idle";
    this.quickBtn.disabled = !enabled;
    this.countdownBtn.disabled = !enabled;
  },
};
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

  // Always kept in sync, regardless of which modal (if any) is open --
  // see canStartNewCapture/MobileCaptureControls.update's own comment.
  MobileCaptureControls.update();

  if (HelpModal.isOpen) {
    // Nothing to track/draw underneath the guide -- and pausing here
    // means no gesture can be mid-registration when it opens or closes.
    requestAnimationFrame(mainLoop);
    return;
  }

  const video = Webcam.videoEl;
  const videoReady = video && video.readyState >= 2 && video.videoWidth;
  const hands = videoReady ? HandTracker.detect(video, nowMs) : [];
  const faces = videoReady ? FaceTracker.detect(video, nowMs) : [];
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

  if (PhotoPreview.isOpen) {
    // Nothing else should track/trigger while the just-captured photo is
    // up for a Keep/Retake decision -- no new frame can start forming
    // underneath it.
    PhotoPreview.update(nowMs, hands, videoW, videoH);
    requestAnimationFrame(mainLoop);
    return;
  }

  // Independent of the capture flow's phase -- picking a strip pattern
  // isn't part of framing/capturing, so it works the same whether you're
  // idle, mid-countdown, or in the flash.
  PatternPicker.updateDwell(nowMs, hands, videoW, videoH);
  BeautyPicker.updateDwell(nowMs, hands, videoW, videoH);

  // Face beauty filters -- every detected face, full camera feed,
  // independent of the hand-frame rectangle below (a no-op draw when both
  // toggles are off).
  drawFaceEffects(video, videoW, videoH, faces);

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
      // No frame is drawn here at all -- it only shows up once a capture
      // is actually in progress (the "countdown"/"flash" phases below,
      // entered either by the pinch-and-hold gesture or by clicking
      // Quick Shot/Countdown Shot), not continuously while idle. A
      // persistent square guide was tried, but reads as clutter/always-
      // on rather than something that appears in response to an action.
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
      CaptureState.pendingPhoto = capturePhoto(video, videoW, videoH, x, y, w, h, nowMs);
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
      // Hand off to the preview -- it decides (via Keep/Retake, or its own
      // timeout) whether this photo actually reaches the strip.
      PhotoPreview.open(CaptureState.pendingPhoto, nowMs);
      CaptureState.pendingPhoto = null;
      // pinchStartMs is untouched by countdown/flash (only the idle branch
      // reads/writes it), so even if the original pinch is still being
      // held through the whole cycle, the next idle frame starts timing a
      // brand new hold from scratch -- it can't immediately re-trigger.
    }
  }

  requestAnimationFrame(mainLoop);
}

async function init() {
  MobileDetect.init();
  Canvas.init();
  initGrain();
  preloadStyleOverlays();
  updateStyleLabel();
  preloadStripPatterns();
  PhotoStrip.init();
  PatternPicker.init();
  BeautyPicker.init();
  MobileCaptureControls.init();
  SizePicker.init();
  RoundCompleteModal.init();
  PhotoPreview.init();
  HelpModal.init();
  HelpModal.open();
  await Promise.all([Webcam.init(), HandTracker.init(), FaceTracker.init()]);
  requestAnimationFrame(mainLoop);
}

init();

