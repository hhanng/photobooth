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

// --- Capture gesture (right-hand pinch) + countdown/flash --------------
// Pinch distance is measured in VIDEO PIXEL space (not normalized, not
// canvas space) -- same approach/threshold ballpark as condensate's pinch
// detection, so a "pinch" means the same physical thing across projects.
const PINCH_DISTANCE_THRESHOLD_PX = 42;
const COUNTDOWN_SECONDS = 4;
const COUNTDOWN_POP_DURATION_S = 0.25; // each number eases in from a larger scale over this long
const FLASH_DURATION_MS = 300;
// -------------------------------------------------------------------------

// --- Vintage filter + film grain --------------------------------------
// ctx.filter accepts a CSS filter-function string, applied to whatever is
// drawn next -- desaturate most of the way, add a touch of warm sepia
// tint, boost contrast a little, and lift brightness slightly so the
// crop doesn't just look "dark and drab".
const VINTAGE_FILTER = "grayscale(0.9) sepia(0.2) contrast(1.15) brightness(1.03)";

// Grain: a handful of pre-rendered static noise tiles (built once, not
// per-frame) cycled every few frames for a subtle flicker, blended with
// "overlay" at low alpha over the vintage crop.
const GRAIN_TILE_SIZE = 128;
const GRAIN_TILE_COUNT = 3;
const GRAIN_ALPHA = 0.08;
const GRAIN_CYCLE_FRAMES = 4;
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
  wasPinching: false, // for rising-edge (single-trigger) pinch detection
  pendingPhoto: null, // captured photo, held from "flash" until it's handed to PuzzleGame
};

// In-memory captured photos -- { canvas, dataUrl, width, height, timestamp }.
const capturedPhotos = [];

// Same distance-in-video-pixel-space approach as condensate's pinch
// detection: thumb (4) and index (8) tip coming within
// PINCH_DISTANCE_THRESHOLD_PX of each other, on the RIGHT hand only.
function isPinching(hand, videoW, videoH) {
  const thumb = hand.landmarks[THUMB_TIP];
  const index = hand.landmarks[INDEX_TIP];
  const dxPx = (thumb.x - index.x) * videoW;
  const dyPx = (thumb.y - index.y) * videoH;
  return Math.hypot(dxPx, dyPx) <= PINCH_DISTANCE_THRESHOLD_PX;
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

let grainFrameCounter = 0;

// Draws the vintage black-and-white preview INSIDE the given canvas-space
// rectangle only (clipped), by cropping the matching region straight out
// of the live video, then the glowing frame outline around it. Outside
// the rectangle, the canvas stays untouched/transparent, so the normal
// color video shows through unaffected.
function drawVintageFrame(rectX, rectY, rectW, rectH, video, videoW, videoH) {
  if (rectW < MIN_FRAME_SIZE || rectH < MIN_FRAME_SIZE) return;
  const ctx = Canvas.ctx;

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
  ctx.filter = VINTAGE_FILTER;
  ctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, rectW, rectH);
  ctx.restore();

  // Film grain overlay, still within the same clip.
  ctx.filter = "none";
  const tile = grainTiles[Math.floor(grainFrameCounter / GRAIN_CYCLE_FRAMES) % grainTiles.length];
  ctx.globalAlpha = GRAIN_ALPHA;
  ctx.globalCompositeOperation = "overlay";
  ctx.drawImage(tile, rectX, rectY, rectW, rectH);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";

  ctx.restore();

  drawFrameOutline(rectX, rectY, rectW, rectH);
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
  pctx.filter = VINTAGE_FILTER;
  pctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, outW, outH);
  pctx.restore();

  pctx.filter = "none";
  const tile = grainTiles[Math.floor(grainFrameCounter / GRAIN_CYCLE_FRAMES) % grainTiles.length];
  pctx.globalAlpha = GRAIN_ALPHA;
  pctx.globalCompositeOperation = "overlay";
  pctx.drawImage(tile, 0, 0, outW, outH);
  pctx.globalAlpha = 1;
  pctx.globalCompositeOperation = "source-over";

  const photo = {
    canvas: photoCanvas,
    dataUrl: photoCanvas.toDataURL("image/png"),
    width: outW,
    height: outH,
    timestamp: Date.now(),
  };
  capturedPhotos.push(photo);
  logCapturedPhoto(photo);
  // Note: this photo is handed to the sliding-puzzle mini-game next
  // (see mainLoop's countdown/flash handling + PuzzleGame.start), NOT
  // added to the strip directly -- PuzzleGame._finish() is what
  // eventually calls PhotoStrip.addPhoto(), once solved or skipped.
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

    if (this.photos.length === STRIP_SLOT_COUNT) {
      composeAndDownloadStrip(this.photos);
      this.reset();
    }
  },

  reset() {
    this.photos = [];
    for (let i = 0; i < STRIP_SLOT_COUNT; i++) this._renderEmptySlot(i);
  },
};

// Draws one photo into the composed strip canvas, cropped ("cover"-style)
// to the slot's aspect ratio since captured photos can be any aspect
// ratio the user happened to frame.
function drawStripSlotImage(ctx, photo, slotX, slotY, slotW, slotH) {
  const srcAspect = photo.width / photo.height;
  const dstAspect = slotW / slotH;
  let sx, sy, sw, sh;
  if (srcAspect > dstAspect) {
    sh = photo.height;
    sw = sh * dstAspect;
    sx = (photo.width - sw) / 2;
    sy = 0;
  } else {
    sw = photo.width;
    sh = sw / dstAspect;
    sx = 0;
    sy = (photo.height - sh) / 2;
  }

  ctx.fillStyle = STRIP_COMPOSE_BORDER;
  ctx.fillRect(
    slotX - STRIP_COMPOSE_BORDER_WIDTH,
    slotY - STRIP_COMPOSE_BORDER_WIDTH,
    slotW + STRIP_COMPOSE_BORDER_WIDTH * 2,
    slotH + STRIP_COMPOSE_BORDER_WIDTH * 2
  );
  ctx.drawImage(photo.canvas, sx, sy, sw, sh, slotX, slotY, slotW, slotH);
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

// --- Sliding puzzle mini-game --------------------------------------------
// Inserted between "capture" and "the strip": PuzzleGame.start(photo) is
// called once, after the capture flash, and PuzzleGame._finish() is what
// eventually calls PhotoStrip.addPhoto() -- capturePhoto() itself no
// longer adds directly. Fully self-contained: mainLoop just checks
// PuzzleGame.phase and, whenever it isn't "hidden", hands the whole frame
// over to PuzzleGame.update()/render() instead of running the normal
// frame-detection/pinch-lock logic, so the two systems never run at the
// same time and can't interfere with each other.
const PUZZLE_GRID_SIZE = 3;
const PUZZLE_TILE_COUNT = PUZZLE_GRID_SIZE * PUZZLE_GRID_SIZE; // 9
const PUZZLE_BLANK_INDEX = PUZZLE_TILE_COUNT - 1; // 8, bottom-right when solved
const PUZZLE_SHUFFLE_MOVES = 120; // random valid slides from solved -- always solvable by construction
const PUZZLE_PREVIEW_DURATION_MS = 1000;
const PUZZLE_SOLVED_FLASH_DURATION_MS = 600;
const PUZZLE_BOARD_SIZE_FRACTION = 0.55; // fraction of min(viewport w, h)
const PUZZLE_TILE_GAP = 3; // px, thin gap between tiles
const PUZZLE_DRAG_SNAP_FRACTION = 0.5; // drag past halfway to commit the slide
const PUZZLE_DRAG_CANCEL_PERP_TILES = 1.2; // moving this many tile-widths off the slide axis cancels the drag

const SKIP_DWELL_MS = 1500;

// Open-palm gesture (right hand, for dragging tiles) -- same distance-
// ratio + hysteresis approach as catscradle/neonpoint's finger-state
// detection, kept local to this feature rather than shared, per the
// "self-contained" ask.
const PALM_FINGER_EXTENDED_ENTER = 1.15;
const PALM_FINGER_EXTENDED_EXIT = 1.05;
const PALM_FINGER_CURLED_ENTER = 0.8;
const PALM_FINGER_CURLED_EXIT = 0.9;
const PALM_FINGER_JOINTS = {
  thumb: [3, 4],
  index: [6, 8],
  middle: [10, 12],
  ring: [14, 16],
  pinky: [18, 20],
};
const PALM_CENTER_LANDMARKS = [0, 5, 9, 13, 17]; // wrist + the four finger MCPs

function palmCenterOf(landmarks) {
  let x = 0;
  let y = 0;
  for (const i of PALM_CENTER_LANDMARKS) {
    x += landmarks[i].x;
    y += landmarks[i].y;
  }
  return { x: x / PALM_CENTER_LANDMARKS.length, y: y / PALM_CENTER_LANDMARKS.length };
}

function palmFingerStateWithHysteresis(ratio, prevState) {
  if (prevState === "extended") {
    if (ratio >= PALM_FINGER_EXTENDED_EXIT) return "extended";
    return ratio <= PALM_FINGER_CURLED_ENTER ? "curled" : "neutral";
  }
  if (prevState === "curled") {
    if (ratio <= PALM_FINGER_CURLED_EXIT) return "curled";
    return ratio >= PALM_FINGER_EXTENDED_ENTER ? "extended" : "neutral";
  }
  if (ratio >= PALM_FINGER_EXTENDED_ENTER) return "extended";
  if (ratio <= PALM_FINGER_CURLED_ENTER) return "curled";
  return "neutral";
}

function computePalmFingerStates(landmarks, prevStates) {
  const palm = palmCenterOf(landmarks);
  const states = {};
  for (const [name, [pipIdx, tipIdx]] of Object.entries(PALM_FINGER_JOINTS)) {
    const pipDist = Math.hypot(landmarks[pipIdx].x - palm.x, landmarks[pipIdx].y - palm.y);
    const tipDist = Math.hypot(landmarks[tipIdx].x - palm.x, landmarks[tipIdx].y - palm.y);
    const ratio = tipDist / pipDist;
    const prevState = prevStates?.[name]?.state ?? "neutral";
    states[name] = { ratio, state: palmFingerStateWithHysteresis(ratio, prevState) };
  }
  return states;
}

function isOpenPalmFromStates(states) {
  return Object.values(states).every((f) => f.state !== "curled");
}

function puzzleAdjacentSlots(slot) {
  const row = Math.floor(slot / PUZZLE_GRID_SIZE);
  const col = slot % PUZZLE_GRID_SIZE;
  const result = [];
  if (row > 0) result.push(slot - PUZZLE_GRID_SIZE);
  if (row < PUZZLE_GRID_SIZE - 1) result.push(slot + PUZZLE_GRID_SIZE);
  if (col > 0) result.push(slot - 1);
  if (col < PUZZLE_GRID_SIZE - 1) result.push(slot + 1);
  return result;
}

// Splits the photo into PUZZLE_TILE_COUNT - 1 tile canvases (index
// PUZZLE_BLANK_INDEX is left null -- the blank has no image), in solved
// left-to-right/top-to-bottom order.
function buildPuzzleTiles(photo) {
  const tileW = photo.width / PUZZLE_GRID_SIZE;
  const tileH = photo.height / PUZZLE_GRID_SIZE;
  const tiles = [];
  for (let row = 0; row < PUZZLE_GRID_SIZE; row++) {
    for (let col = 0; col < PUZZLE_GRID_SIZE; col++) {
      const idx = row * PUZZLE_GRID_SIZE + col;
      if (idx === PUZZLE_BLANK_INDEX) {
        tiles.push(null);
        continue;
      }
      const off = document.createElement("canvas");
      off.width = Math.max(1, Math.round(tileW));
      off.height = Math.max(1, Math.round(tileH));
      const octx = off.getContext("2d");
      octx.drawImage(photo.canvas, col * tileW, row * tileH, tileW, tileH, 0, 0, off.width, off.height);
      tiles.push(off);
    }
  }
  return tiles;
}

// board[slot] = the ORIGINAL tile index currently sitting in that grid
// slot (solved: board[i] === i, with board[PUZZLE_BLANK_INDEX] holding
// the blank marker). Shuffles by performing PUZZLE_SHUFFLE_MOVES random
// valid slides from the solved state -- any sequence of legal moves from
// solved is, by construction, always solvable (just undo them), avoiding
// the classic "naive random permutation is often unsolvable" pitfall.
function shufflePuzzleBoard(moves) {
  const board = Array.from({ length: PUZZLE_TILE_COUNT }, (_, i) => i);
  let blankSlot = PUZZLE_BLANK_INDEX;
  let lastSlot = -1;
  for (let m = 0; m < moves; m++) {
    const neighbors = puzzleAdjacentSlots(blankSlot);
    const candidates = neighbors.filter((s) => s !== lastSlot);
    const pool = candidates.length > 0 ? candidates : neighbors;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    board[blankSlot] = board[pick];
    board[pick] = PUZZLE_BLANK_INDEX;
    lastSlot = blankSlot;
    blankSlot = pick;
  }
  return { board, blankSlot };
}

function puzzleBoardGeometry() {
  const boardSize = Math.min(Canvas.width, Canvas.height) * PUZZLE_BOARD_SIZE_FRACTION;
  const boardX = (Canvas.width - boardSize) / 2;
  const boardY = (Canvas.height - boardSize) / 2;
  const tileSize = boardSize / PUZZLE_GRID_SIZE;
  return { boardSize, boardX, boardY, tileSize };
}

function setSkipButtonVisible(visible) {
  const btn = document.getElementById("skip-button");
  btn.style.display = visible ? "flex" : "none";
  if (!visible) {
    btn.style.setProperty("--dwell-progress", "0");
    btn.classList.remove("dwelling");
  }
}

const PuzzleGame = {
  phase: "hidden", // "hidden" | "preview" | "puzzle" | "solved"
  photo: null,
  tiles: null,
  board: null,
  blankSlot: null,
  previewStartMs: null,
  solvedStartMs: null,
  drag: null, // { slot, tileIndex, axis, dir, startPalm, offsetX, offsetY } or null
  rightHandFingerMemory: null,
  skipDwellStartMs: null,

  start(photo, nowMs) {
    this.phase = "preview";
    this.photo = photo;
    this.previewStartMs = nowMs;
    this.tiles = null;
    this.board = null;
    this.blankSlot = null;
    this.drag = null;
    this.rightHandFingerMemory = null;
    this.skipDwellStartMs = null;
    setSkipButtonVisible(false);
  },

  update(nowMs, hands, videoW, videoH) {
    if (this.phase === "preview") {
      if (nowMs - this.previewStartMs >= PUZZLE_PREVIEW_DURATION_MS) this._beginPuzzle();
      return;
    }
    if (this.phase === "puzzle") {
      this._updateDwellSkip(hands, videoW, videoH);
      this._updateTileDrag(nowMs, hands, videoW, videoH);
      return;
    }
    if (this.phase === "solved") {
      if (nowMs - this.solvedStartMs >= PUZZLE_SOLVED_FLASH_DURATION_MS) this._finish();
    }
  },

  render(nowMs) {
    const ctx = Canvas.ctx;
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(0, 0, Canvas.width, Canvas.height);

    if (this.phase === "preview") {
      this._drawCenteredPhoto();
    } else if (this.phase === "puzzle") {
      this._drawBoard();
    } else if (this.phase === "solved") {
      this._drawBoard();
      const t = clamp((nowMs - this.solvedStartMs) / PUZZLE_SOLVED_FLASH_DURATION_MS, 0, 1);
      const alpha = Math.sin(t * Math.PI) * 0.6;
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.fillRect(0, 0, Canvas.width, Canvas.height);
    }
  },

  _beginPuzzle() {
    this.tiles = buildPuzzleTiles(this.photo);
    const { board, blankSlot } = shufflePuzzleBoard(PUZZLE_SHUFFLE_MOVES);
    this.board = board;
    this.blankSlot = blankSlot;
    this.phase = "puzzle";
    setSkipButtonVisible(true);
  },

  _drawCenteredPhoto() {
    const ctx = Canvas.ctx;
    const maxSize = Math.min(Canvas.width, Canvas.height) * PUZZLE_BOARD_SIZE_FRACTION;
    const aspect = this.photo.width / this.photo.height;
    const drawW = aspect >= 1 ? maxSize : maxSize * aspect;
    const drawH = aspect >= 1 ? maxSize / aspect : maxSize;
    const x = (Canvas.width - drawW) / 2;
    const y = (Canvas.height - drawH) / 2;

    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
    ctx.shadowBlur = 24;
    ctx.drawImage(this.photo.canvas, x, y, drawW, drawH);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, drawW, drawH);
    ctx.restore();
  },

  _drawBoard() {
    const ctx = Canvas.ctx;
    const { boardX, boardY, boardSize, tileSize } = puzzleBoardGeometry();

    for (let slot = 0; slot < PUZZLE_TILE_COUNT; slot++) {
      const tileIndex = this.board[slot];
      if (tileIndex === PUZZLE_BLANK_INDEX) continue;
      const row = Math.floor(slot / PUZZLE_GRID_SIZE);
      const col = slot % PUZZLE_GRID_SIZE;
      let drawX = boardX + col * tileSize;
      let drawY = boardY + row * tileSize;
      if (this.drag && this.drag.slot === slot) {
        drawX += this.drag.offsetX;
        drawY += this.drag.offsetY;
      }
      ctx.drawImage(
        this.tiles[tileIndex],
        drawX + PUZZLE_TILE_GAP / 2,
        drawY + PUZZLE_TILE_GAP / 2,
        tileSize - PUZZLE_TILE_GAP,
        tileSize - PUZZLE_TILE_GAP
      );
    }

    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
    ctx.lineWidth = 2;
    ctx.strokeRect(boardX, boardY, boardSize, boardSize);
    ctx.restore();
  },

  // Either hand's index fingertip hovering continuously over the Skip
  // button for SKIP_DWELL_MS triggers a skip -- leaving the button area
  // at any point resets the dwell timer.
  _updateDwellSkip(hands, videoW, videoH) {
    const btn = document.getElementById("skip-button");
    const rect = btn.getBoundingClientRect();
    let hovering = false;
    for (const hand of hands) {
      const tip = hand.landmarks[INDEX_TIP];
      const p = mapVideoToCanvas(tip.x, tip.y, videoW, videoH, Canvas.width, Canvas.height);
      if (p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom) {
        hovering = true;
        break;
      }
    }

    if (!hovering) {
      this.skipDwellStartMs = null;
      btn.style.setProperty("--dwell-progress", "0");
      btn.classList.remove("dwelling");
      return;
    }

    if (this.skipDwellStartMs === null) this.skipDwellStartMs = performance.now();
    const progress = clamp((performance.now() - this.skipDwellStartMs) / SKIP_DWELL_MS, 0, 1);
    btn.style.setProperty("--dwell-progress", String(progress));
    btn.classList.add("dwelling");
    if (progress >= 1) this.skip();
  },

  // Right-hand open-palm tile dragging: hovering an open palm over a tile
  // adjacent to the blank arms a drag; moving the palm toward the blank
  // slides the tile (constrained to that single axis) and commits the
  // slide past PUZZLE_DRAG_SNAP_FRACTION; closing the hand, or drifting
  // too far off the slide axis, cancels an uncommitted drag.
  _updateTileDrag(nowMs, hands, videoW, videoH) {
    const rightHand = hands.find((h) => h.handedness === "Right") || null;
    if (!rightHand) {
      this.rightHandFingerMemory = null;
      this.drag = null;
      return;
    }

    const fingerStates = computePalmFingerStates(rightHand.landmarks, this.rightHandFingerMemory);
    this.rightHandFingerMemory = fingerStates;
    const isOpen = isOpenPalmFromStates(fingerStates);

    const palmNorm = palmCenterOf(rightHand.landmarks);
    const palmScreen = mapVideoToCanvas(palmNorm.x, palmNorm.y, videoW, videoH, Canvas.width, Canvas.height);
    const { boardX, boardY, tileSize } = puzzleBoardGeometry();

    if (!this.drag) {
      if (!isOpen) return;
      const col = Math.floor((palmScreen.x - boardX) / tileSize);
      const row = Math.floor((palmScreen.y - boardY) / tileSize);
      if (col < 0 || col >= PUZZLE_GRID_SIZE || row < 0 || row >= PUZZLE_GRID_SIZE) return;
      const slot = row * PUZZLE_GRID_SIZE + col;
      if (slot === this.blankSlot || !puzzleAdjacentSlots(this.blankSlot).includes(slot)) return;

      const blankRow = Math.floor(this.blankSlot / PUZZLE_GRID_SIZE);
      const blankCol = this.blankSlot % PUZZLE_GRID_SIZE;
      const axis = row === blankRow ? "x" : "y";
      const dir = axis === "x" ? Math.sign(blankCol - col) : Math.sign(blankRow - row);

      this.drag = { slot, tileIndex: this.board[slot], axis, dir, startPalm: palmScreen, offsetX: 0, offsetY: 0 };
      return;
    }

    if (!isOpen) {
      this.drag = null;
      return;
    }

    const dx = palmScreen.x - this.drag.startPalm.x;
    const dy = palmScreen.y - this.drag.startPalm.y;
    const perp = this.drag.axis === "x" ? dy : dx;
    if (Math.abs(perp) > tileSize * PUZZLE_DRAG_CANCEL_PERP_TILES) {
      this.drag = null;
      return;
    }

    const forward = (this.drag.axis === "x" ? dx : dy) * this.drag.dir;
    const fraction = clamp(forward / tileSize, 0, 1);
    this.drag.offsetX = this.drag.axis === "x" ? this.drag.dir * fraction * tileSize : 0;
    this.drag.offsetY = this.drag.axis === "y" ? this.drag.dir * fraction * tileSize : 0;

    if (fraction >= PUZZLE_DRAG_SNAP_FRACTION) {
      const fromSlot = this.drag.slot;
      const toSlot = this.blankSlot;
      this.board[toSlot] = this.board[fromSlot];
      this.board[fromSlot] = PUZZLE_BLANK_INDEX;
      this.blankSlot = fromSlot;
      this.drag = null;

      if (this.board.every((tileIndex, slot) => tileIndex === slot)) {
        this.phase = "solved";
        this.solvedStartMs = nowMs;
        setSkipButtonVisible(false);
      }
    }
  },

  skip() {
    if (this.phase !== "puzzle") return;
    this._finish();
  },

  _finish() {
    const photo = this.photo;
    this.phase = "hidden";
    this.photo = null;
    this.tiles = null;
    this.board = null;
    this.blankSlot = null;
    this.drag = null;
    this.rightHandFingerMemory = null;
    this.skipDwellStartMs = null;
    setSkipButtonVisible(false);
    PhotoStrip.addPhoto(photo);
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

  const video = Webcam.videoEl;
  const hands = video && video.readyState >= 2 && video.videoWidth ? HandTracker.detect(video, nowMs) : [];
  const videoW = video?.videoWidth || 0;
  const videoH = video?.videoHeight || 0;

  // While the puzzle mini-game is up, it fully owns the frame -- the
  // normal frame-detection/pinch-lock logic below doesn't run at all,
  // so the two systems never interfere with each other.
  if (PuzzleGame.phase !== "hidden") {
    PuzzleGame.update(nowMs, hands, videoW, videoH);
    PuzzleGame.render(nowMs);
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

      drawVintageFrame(minX, minY, rectW, rectH, video, videoW, videoH);

      // Pinch is a single trigger (rising edge only), not "while held",
      // and only arms the countdown if there's a real rectangle to lock.
      const pinching = isPinching(rightHand, videoW, videoH);
      if (pinching && !CaptureState.wasPinching && rectW >= MIN_FRAME_SIZE && rectH >= MIN_FRAME_SIZE) {
        startCountdown(minX, minY, rectW, rectH, nowMs);
      }
      CaptureState.wasPinching = pinching;
    } else {
      // Reset so the rectangle snaps to the raw position next time both
      // hands appear, instead of smoothing in from wherever it was left.
      FrameSmoothingState.points = null;
      CaptureState.wasPinching = false;
    }
  } else if (CaptureState.phase === "countdown") {
    // Locked: geometry is frozen, but the video feed inside it stays
    // live -- hands are free to move or leave frame entirely.
    const { x, y, w, h } = CaptureState.lockedRect;
    drawVintageFrame(x, y, w, h, video, videoW, videoH);
    drawCountdownNumber(x, y, w, h, nowMs);

    if (nowMs - CaptureState.countdownStartMs >= COUNTDOWN_SECONDS * 1000) {
      CaptureState.pendingPhoto = capturePhoto(video, videoW, videoH, x, y, w, h);
      CaptureState.phase = "flash";
      CaptureState.flashStartMs = nowMs;
    }
  } else if (CaptureState.phase === "flash") {
    const { x, y, w, h } = CaptureState.lockedRect;
    drawVintageFrame(x, y, w, h, video, videoW, videoH);
    drawFlash(nowMs - CaptureState.flashStartMs);

    if (nowMs - CaptureState.flashStartMs >= FLASH_DURATION_MS) {
      CaptureState.phase = "idle";
      CaptureState.lockedRect = null;
      // Assume still-pinching until proven otherwise next idle frame, so
      // a pinch held all the way through the countdown can't immediately
      // re-trigger a second capture the instant we unlock.
      CaptureState.wasPinching = true;

      const photo = CaptureState.pendingPhoto;
      CaptureState.pendingPhoto = null;
      PuzzleGame.start(photo, nowMs);
    }
  }

  requestAnimationFrame(mainLoop);
}

function setupSkipButton() {
  document.getElementById("skip-button").addEventListener("click", () => PuzzleGame.skip());
}

async function init() {
  Canvas.init();
  initGrain();
  PhotoStrip.init();
  setupSkipButton();
  await Promise.all([Webcam.init(), HandTracker.init()]);
  requestAnimationFrame(mainLoop);
}

init();
