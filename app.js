import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.3.289/pdf.min.mjs";

const PDFJS_VERSION = "6.3.289";
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.mjs`;

const $ = (id) => document.getElementById(id);
const els = {
  pdfInput: $("pdfInput"),
  pdfInputSecondary: $("pdfInputSecondary"),
  locateButton: $("locateButton"),
  centerButton: $("centerButton"),
  minusButton: $("minusButton"),
  plusButton: $("plusButton"),
  fitButton: $("fitButton"),
  clearButton: $("clearButton"),
  mapViewport: $("mapViewport"),
  mapStage: $("mapStage"),
  pdfCanvas: $("pdfCanvas"),
  markerLayer: $("markerLayer"),
  accuracyCircle: $("accuracyCircle"),
  locationMarker: $("locationMarker"),
  headingIndicator: $("headingIndicator"),
  headingValue: $("headingValue"),
  compassStatus: $("compassStatus"),
  emptyState: $("emptyState"),
  loadingState: $("loadingState"),
  loadingText: $("loadingText"),
  networkStatus: $("networkStatus"),
  latValue: $("latValue"),
  lonValue: $("lonValue"),
  accuracyValue: $("accuracyValue"),
  gpsStatus: $("gpsStatus"),
  fileName: $("fileName"),
  geoStatus: $("geoStatus"),
  crsValue: $("crsValue"),
  offlinePdfStatus: $("offlinePdfStatus"),
  message: $("message")
};

const state = {
  pdfBytes: null,
  pdfDoc: null,
  page: null,
  viewport: null,
  geo: null,
  fileName: null,
  zoom: 1,
  fitZoom: 1,
  tx: 0,
  ty: 0,
  gpsWatchId: null,
  orientationListening: false,
  lastHeading: null,
  lastOrientationEvent: null,
  lastPosition: null,
  drag: null,
  pointers: new Map(),
  pinch: null,
  lastTapAt: 0,
  viewportCssScale: 1
};

function setMessage(text, kind = "normal") {
  els.message.textContent = text;
  els.message.dataset.kind = kind;
}

function setLoading(show, text = "Loading PDF…") {
  els.loadingState.hidden = !show;
  els.loadingText.textContent = text;
}

function setMapEnabled(enabled) {
  for (const button of [els.centerButton, els.minusButton, els.plusButton, els.fitButton, els.clearButton]) {
    button.disabled = !enabled;
  }
}

function formatCoord(value) {
  return Number.isFinite(value) ? value.toFixed(6) : "—";
}

function formatAccuracy(value) {
  return Number.isFinite(value) ? `±${value.toFixed(value < 10 ? 1 : 0)} m` : "—";
}

function numbersFrom(text) {
  return (text.match(/[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g) || []).map(Number);
}

function parseGeoPDF(bytes) {
  const text = new TextDecoder("latin1").decode(bytes);
  const geoMarker = text.indexOf("/Subtype /GEO");
  if (geoMarker < 0) throw new Error("No /Measure /GEO dictionary was found in this PDF.");

  const segment = text.slice(Math.max(0, geoMarker - 2500), Math.min(text.length, geoMarker + 14000));
  const bboxMatch = segment.match(/\/BBox\s*\[\s*([^\]]+)\]/);
  const gptsMatch = segment.match(/\/GPTS\s*\[\s*([^\]]+)\]/);
  const lptsMatch = segment.match(/\/LPTS\s*\[\s*([^\]]+)\]/);
  const projMatch = segment.match(/\/WKT\s*\(\s*PROJCS\["([^"]+)"/);

  const bbox = bboxMatch ? numbersFrom(bboxMatch[1]) : null;
  const gpts = gptsMatch ? numbersFrom(gptsMatch[1]) : null;
  const lpts = lptsMatch ? numbersFrom(lptsMatch[1]) : null;
  const crsName = projMatch?.[1] || "Embedded GeoPDF CRS";

  if (!bbox || bbox.length < 4) throw new Error("GeoPDF is missing the map viewport BBox.");
  if (!gpts || gpts.length < 8 || !lpts || lpts.length < 8) {
    throw new Error("GeoPDF is missing a four-corner GPTS/LPTS map registration.");
  }

  const points = [];
  for (let i = 0; i < 4; i++) {
    points.push({
      lat: gpts[i * 2],
      lon: gpts[i * 2 + 1],
      u: lpts[i * 2],
      v: lpts[i * 2 + 1]
    });
  }

  const find = (u, v) => points.find((p) => Math.abs(p.u - u) < 1e-8 && Math.abs(p.v - v) < 1e-8);
  const p00 = find(0, 0), p01 = find(0, 1), p11 = find(1, 1), p10 = find(1, 0);
  if (!p00 || !p01 || !p11 || !p10) throw new Error("GeoPDF LPTS corners are not in the expected 0–1 layout.");

  return {
    bbox: { xMin: bbox[0], yMin: bbox[1], xMax: bbox[2], yMax: bbox[3] },
    corners: { p00: [p00.lon, p00.lat], p01: [p01.lon, p01.lat], p11: [p11.lon, p11.lat], p10: [p10.lon, p10.lat] },
    crsName,
    gpts,
    lpts
  };
}

function bilinear(c, u, v) {
  const a = (1 - u) * (1 - v);
  const b = (1 - u) * v;
  const d = u * v;
  const e = u * (1 - v);
  return [
    c.p00[0] * a + c.p01[0] * b + c.p11[0] * d + c.p10[0] * e,
    c.p00[1] * a + c.p01[1] * b + c.p11[1] * d + c.p10[1] * e
  ];
}

function bilinearDerivatives(c, u, v) {
  const du = [
    (1 - v) * (c.p10[0] - c.p00[0]) + v * (c.p11[0] - c.p01[0]),
    (1 - v) * (c.p10[1] - c.p00[1]) + v * (c.p11[1] - c.p01[1])
  ];
  const dv = [
    (1 - u) * (c.p01[0] - c.p00[0]) + u * (c.p11[0] - c.p10[0]),
    (1 - u) * (c.p01[1] - c.p00[1]) + u * (c.p11[1] - c.p10[1])
  ];
  return { du, dv };
}

function inverseBilinear(c, lon, lat) {
  let u = 0.5, v = 0.5;
  for (let i = 0; i < 12; i++) {
    const [x, y] = bilinear(c, u, v);
    const fx = x - lon;
    const fy = y - lat;
    if (Math.hypot(fx, fy) < 1e-10) break;
    const { du, dv } = bilinearDerivatives(c, u, v);
    const det = du[0] * dv[1] - du[1] * dv[0];
    if (Math.abs(det) < 1e-14) break;
    const duStep = (fx * dv[1] - fy * dv[0]) / det;
    const dvStep = (du[0] * fy - du[1] * fx) / det;
    u -= duStep;
    v -= dvStep;
    if (Math.max(Math.abs(duStep), Math.abs(dvStep)) < 1e-10) break;
  }
  return { u, v };
}


function normalizeHeading(value) {
  if (!Number.isFinite(value)) return null;
  return ((value % 360) + 360) % 360;
}

function orientationHeading(event) {
  // iOS Safari exposes a calibrated magnetic/true-north heading directly.
  if (Number.isFinite(event.webkitCompassHeading)) {
    return normalizeHeading(event.webkitCompassHeading);
  }

  // Standard absolute orientation: alpha is measured around the Z axis.
  if (Number.isFinite(event.alpha)) {
    let heading = 360 - event.alpha;
    const screenAngle = Number.isFinite(screen.orientation?.angle)
      ? screen.orientation.angle
      : (Number.isFinite(window.orientation) ? window.orientation : 0);
    heading += screenAngle;
    return normalizeHeading(heading);
  }

  return null;
}

function updateHeadingIndicator() {
  const heading = state.lastHeading;
  const position = state.lastPosition;
  if (!Number.isFinite(heading) || !position || !state.viewport) {
    els.headingIndicator.hidden = true;
    return;
  }

  const point = pagePointFromGps(position.coords.latitude, position.coords.longitude);
  const cssScale = state.viewportCssScale || 1;
  const northStep = 0.00008;
  const northPoint = pagePointFromGps(position.coords.latitude + northStep, position.coords.longitude);
  const dxNorth = (northPoint.viewportX - point.viewportX) * cssScale;
  const dyNorth = (northPoint.viewportY - point.viewportY) * cssScale;
  const northAngle = Math.atan2(dyNorth, dxNorth) * 180 / Math.PI;
  const screenAngle = northAngle + heading;

  els.headingIndicator.style.left = `${point.viewportX * cssScale}px`;
  els.headingIndicator.style.top = `${point.viewportY * cssScale}px`;
  els.headingIndicator.style.setProperty("--heading-angle", `${screenAngle}deg`);
  els.headingIndicator.hidden = false;
  els.headingValue.textContent = `${Math.round(heading)}° ${headingCardinal(heading)}`;
}

function headingCardinal(degrees) {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return names[Math.round(degrees / 45) % 8];
}

async function startOrientation() {
  if (!("DeviceOrientationEvent" in window)) {
    els.compassStatus.textContent = "Unavailable";
    setMessage("This device/browser does not expose a device orientation sensor.", "warn");
    return;
  }

  try {
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      const permission = await DeviceOrientationEvent.requestPermission(true);
      if (permission !== "granted") {
        els.compassStatus.textContent = "Permission denied";
        setMessage("Compass permission was denied. Location will still work.", "warn");
        return;
      }
    }

    if (!state.orientationListening) {
      window.addEventListener("deviceorientationabsolute", onOrientation, true);
      window.addEventListener("deviceorientation", onOrientation, true);
      state.orientationListening = true;
    }
    els.compassStatus.textContent = "Waiting for heading";
  } catch (error) {
    console.warn("Orientation permission failed", error);
    els.compassStatus.textContent = "Unavailable";
    setMessage("Compass access could not be enabled. Location will still work.", "warn");
  }
}

function onOrientation(event) {
  const heading = orientationHeading(event);
  if (!Number.isFinite(heading)) return;
  state.lastHeading = heading;
  state.lastOrientationEvent = event;
  els.compassStatus.textContent = event.absolute || Number.isFinite(event.webkitCompassHeading)
    ? "Active"
    : "Relative";
  updateHeadingIndicator();
}

function pagePointFromGps(lat, lon) {
  const uv = inverseBilinear(state.geo.corners, lon, lat);
  const { xMin, yMin, xMax, yMax } = state.geo.bbox;
  const pdfX = xMin + uv.u * (xMax - xMin);
  const pdfY = yMin + uv.v * (yMax - yMin);
  const [viewportX, viewportY] = state.viewport.convertToViewportPoint(pdfX, pdfY);
  return { ...uv, pdfX, pdfY, viewportX, viewportY };
}

function clampTranslation() {
  if (!state.viewport) return;
  const box = els.mapViewport.getBoundingClientRect();
  const stageWidth = state.viewport.width * (state.viewportCssScale || 1) * state.zoom;
  const stageHeight = state.viewport.height * (state.viewportCssScale || 1) * state.zoom;
  const maxX = Math.max(0, (stageWidth - box.width) / 2);
  const maxY = Math.max(0, (stageHeight - box.height) / 2);
  state.tx = Math.max(-maxX, Math.min(maxX, state.tx));
  state.ty = Math.max(-maxY, Math.min(maxY, state.ty));
}

function setStageTransform() {
  clampTranslation();
  els.mapStage.style.transform = `translate(calc(-50% + ${state.tx}px), calc(-50% + ${state.ty}px)) scale(${state.zoom})`;
}

function fitStage() {
  if (!state.viewport) return;
  const box = els.mapViewport.getBoundingClientRect();
  const pageWidth = state.viewport.width;
  const pageHeight = state.viewport.height;
  // Fill the entire map viewport with a cover-style fit.
  const fit = Math.max(box.width / pageWidth, box.height / pageHeight);
  state.fitZoom = Math.max(0.25, Math.min(2.4, fit));
  state.zoom = state.fitZoom;
  state.tx = 0;
  state.ty = 0;
  setStageTransform();
  updateLocationOverlay();
}

function zoomBy(factor) {
  const oldZoom = state.zoom;
  state.zoom = Math.max(state.fitZoom * 0.65, Math.min(state.fitZoom * 4, oldZoom * factor));
  setStageTransform();
  updateLocationOverlay();
}

async function renderPdf(inputBytes, fileName) {
  // PDF.js may transfer/detach the ArrayBuffer backing the data it receives.
  // Always give PDF.js its own copy so the original bytes remain cloneable by IndexedDB.
  const sourceBytes = inputBytes instanceof ArrayBuffer ? new Uint8Array(inputBytes) : inputBytes;
  if (!(sourceBytes instanceof Uint8Array)) {
    throw new Error("Invalid PDF byte data.");
  }
  const storageBytes = sourceBytes.slice();
  const pdfJsBytes = sourceBytes.slice();

  setLoading(true, "Reading GeoPDF…");
  const geo = parseGeoPDF(storageBytes);
  setLoading(true, "Rendering PDF…");

  const loadingTask = pdfjsLib.getDocument({ data: pdfJsBytes });
  const pdfDoc = await loadingTask.promise;
  const page = await pdfDoc.getPage(1);
  const viewport = page.getViewport({ scale: 1, rotation: page.rotate || 0 });

  state.pdfBytes = storageBytes;
  state.pdfDoc = pdfDoc;
  state.page = page;
  state.viewport = viewport;
  state.geo = geo;
  state.fileName = fileName;

  const canvas = els.pdfCanvas;
  const box = els.mapViewport.getBoundingClientRect();
  const fitCss = Math.min((box.width - 12) / viewport.width, (box.height - 12) / viewport.height);
  const cssScale = Math.max(0.25, Math.min(1.8, fitCss));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const renderScale = cssScale * dpr;
  const renderViewport = page.getViewport({ scale: renderScale, rotation: page.rotate || 0 });

  canvas.width = Math.ceil(renderViewport.width);
  canvas.height = Math.ceil(renderViewport.height);
  canvas.style.width = `${viewport.width * cssScale}px`;
  canvas.style.height = `${viewport.height * cssScale}px`;
  els.mapStage.style.width = `${viewport.width * cssScale}px`;
  els.mapStage.style.height = `${viewport.height * cssScale}px`;
  els.markerLayer.style.width = `${viewport.width * cssScale}px`;
  els.markerLayer.style.height = `${viewport.height * cssScale}px`;

  await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport: renderViewport }).promise;

  state.viewportCssScale = cssScale;
  els.fileName.textContent = fileName;
  els.geoStatus.textContent = "Embedded GEO";
  els.crsValue.textContent = geo.crsName;
  els.offlinePdfStatus.textContent = "Saving…";
  els.emptyState.hidden = true;
  els.mapStage.hidden = false;
  setMapEnabled(true);
  fitStage();
  setLoading(false);
  setMessage("GeoPDF loaded. Start location updates to place the device on the map.");

  await savePdfToIndexedDb({ fileName, bytes: storageBytes, geo });
  els.offlinePdfStatus.textContent = "Offline ready";
  setMessage("GeoPDF loaded and stored locally. The map can now be reopened offline.");
}

function updateLocationOverlay() {
  const position = state.lastPosition;
  if (!position || !state.viewport) return;
  const point = pagePointFromGps(position.coords.latitude, position.coords.longitude);
  const cssScale = state.viewportCssScale || 1;
  const x = point.viewportX * cssScale;
  const y = point.viewportY * cssScale;
  const within = point.u >= -0.01 && point.u <= 1.01 && point.v >= -0.01 && point.v <= 1.01;

  els.locationMarker.hidden = !within;
  els.accuracyCircle.hidden = !within;
  if (!within) {
    setMessage("GPS position is outside the GeoPDF map frame.", "warn");
    return;
  }

  els.locationMarker.style.left = `${x}px`;
  els.locationMarker.style.top = `${y}px`;

  const accuracy = Number(position.coords.accuracy) || 0;
  const lat = position.coords.latitude * Math.PI / 180;
  const dLat = accuracy / 111320;
  const dLon = accuracy / (111320 * Math.max(Math.cos(lat), 0.15));
  const a = pagePointFromGps(position.coords.latitude + dLat, position.coords.longitude);
  const b = pagePointFromGps(position.coords.latitude, position.coords.longitude + dLon);
  const radiusX = Math.abs(b.viewportX - point.viewportX) * cssScale;
  const radiusY = Math.abs(a.viewportY - point.viewportY) * cssScale;
  const radius = Math.max(8, Math.max(radiusX, radiusY));
  els.accuracyCircle.style.left = `${x}px`;
  els.accuracyCircle.style.top = `${y}px`;
  els.accuracyCircle.style.width = `${radius * 2}px`;
  els.accuracyCircle.style.height = `${radius * 2}px`;
}

function onPosition(position) {
  state.lastPosition = position;
  const { latitude, longitude, accuracy } = position.coords;
  els.latValue.textContent = formatCoord(latitude);
  els.lonValue.textContent = formatCoord(longitude);
  els.accuracyValue.textContent = formatAccuracy(accuracy);
  els.gpsStatus.textContent = "Receiving fixes";
  updateLocationOverlay();
  updateHeadingIndicator();
}

function onPositionError(error) {
  els.gpsStatus.textContent = `Error ${error.code}`;
  const messages = {
    1: "Location permission was denied.",
    2: "Location is unavailable.",
    3: "Location request timed out."
  };
  setMessage(messages[error.code] || "Unable to obtain a location fix.", "warn");
}

function startGps() {
  if (!("geolocation" in navigator)) {
    setMessage("This browser does not expose device geolocation.", "warn");
    return;
  }
  if (state.gpsWatchId !== null) navigator.geolocation.clearWatch(state.gpsWatchId);
  els.gpsStatus.textContent = "Requesting permission…";
  startOrientation();
  state.gpsWatchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 3000,
    timeout: 20000
  });
}

async function savePdfToIndexedDb(record) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("pdf", "readwrite");
    tx.objectStore("pdf").put({ id: "last", ...record });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function loadStoredPdf() {
  try {
    const db = await openDb();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction("pdf", "readonly");
      const request = tx.objectStore("pdf").get("last");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    if (!record?.bytes) return;
    els.offlinePdfStatus.textContent = "Stored locally";
    setLoading(true, "Restoring saved GeoPDF…");
    await renderPdf(record.bytes, record.fileName || "Saved GeoPDF");
  } catch (error) {
    console.warn("Stored PDF restore failed", error);
    els.offlinePdfStatus.textContent = "Not available";
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("geopdf-navigator", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("pdf")) request.result.createObjectStore("pdf", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function clearStoredPdf() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("pdf", "readwrite");
    tx.objectStore("pdf").clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function loadSelectedFile(file) {
  if (!file) return;
  setLoading(true, "Reading file…");
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const bytes = reader.result;
      await renderPdf(bytes, file.name);
    } catch (error) {
      console.error(error);
      setLoading(false);
      setMessage(error?.message || "The PDF could not be opened.", "warn");
      els.offlinePdfStatus.textContent = "Not loaded";
    }
  };
  reader.onerror = () => {
    setLoading(false);
    setMessage("The file could not be read.", "warn");
  };
  reader.readAsArrayBuffer(file);
}

function clearMap() {
  state.pdfBytes = null;
  state.pdfDoc?.destroy?.();
  state.pdfDoc = null;
  state.page = null;
  state.viewport = null;
  state.geo = null;
  state.fileName = null;
  state.lastPosition = state.lastPosition;
  els.mapStage.hidden = true;
  els.emptyState.hidden = false;
  els.locationMarker.hidden = true;
  els.accuracyCircle.hidden = true;
  els.fileName.textContent = "—";
  els.geoStatus.textContent = "—";
  els.crsValue.textContent = "—";
  els.offlinePdfStatus.textContent = "—";
  setMapEnabled(false);
  setMessage("Map cleared. The locally stored copy remains until you choose Clear & Delete.");
}

async function clearAndDelete() {
  await clearStoredPdf();
  clearMap();
  els.offlinePdfStatus.textContent = "Deleted";
  setMessage("The locally stored GeoPDF has been deleted.");
}

function centerOnMe() {
  if (!state.lastPosition || !state.viewport) return;
  const point = pagePointFromGps(state.lastPosition.coords.latitude, state.lastPosition.coords.longitude);
  const scale = state.viewportCssScale || 1;
  const targetX = (point.viewportX * scale - state.viewport.width * scale / 2);
  const targetY = (point.viewportY * scale - state.viewport.height * scale / 2);
  state.tx -= targetX * state.zoom;
  state.ty -= targetY * state.zoom;
  setStageTransform();
  updateLocationOverlay();
}

function pointerDown(e) {
  els.mapViewport.setPointerCapture?.(e.pointerId);
  state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (state.pointers.size === 1) {
    state.drag = { startX: e.clientX, startY: e.clientY, tx: state.tx, ty: state.ty };
  } else if (state.pointers.size === 2) {
    const [a, b] = [...state.pointers.values()];
    state.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: state.zoom };
    state.drag = null;
  }
}

function pointerMove(e) {
  if (!state.pointers.has(e.pointerId)) return;
  state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (state.pointers.size === 2 && state.pinch) {
    const [a, b] = [...state.pointers.values()];
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    state.zoom = Math.max(state.fitZoom * 0.65, Math.min(state.fitZoom * 4, state.pinch.zoom * distance / state.pinch.distance));
    setStageTransform();
    updateLocationOverlay();
  } else if (state.drag) {
    state.tx = state.drag.tx + (e.clientX - state.drag.startX);
    state.ty = state.drag.ty + (e.clientY - state.drag.startY);
    setStageTransform();
    updateLocationOverlay();
  }
}

function pointerUp(e) {
  const now = performance.now();
  const wasTap = state.drag && Math.hypot(e.clientX - state.drag.startX, e.clientY - state.drag.startY) < 8;
  if (wasTap && now - state.lastTapAt < 320) {
    zoomBy(1.45);
  }
  state.lastTapAt = wasTap ? now : 0;
  state.pointers.delete(e.pointerId);
  state.drag = null;
  if (state.pointers.size < 2) state.pinch = null;
}

function setNetworkStatus() {
  const online = navigator.onLine;
  els.networkStatus.textContent = online ? "Online" : "Offline";
  els.networkStatus.style.color = online ? "var(--ok)" : "var(--accent-2)";
}

window.addEventListener("resize", () => {
  if (state.viewport) fitStage();
});
window.addEventListener("online", setNetworkStatus);
window.addEventListener("offline", setNetworkStatus);

els.pdfInput.addEventListener("change", (e) => loadSelectedFile(e.target.files?.[0]));
els.pdfInputSecondary.addEventListener("change", (e) => loadSelectedFile(e.target.files?.[0]));
els.locateButton.addEventListener("click", () => {
  startGps();
  startOrientation();
});
els.centerButton.addEventListener("click", centerOnMe);
els.minusButton.addEventListener("click", () => zoomBy(0.75));
els.plusButton.addEventListener("click", () => zoomBy(1.35));
els.fitButton.addEventListener("click", fitStage);
els.clearButton.addEventListener("click", async () => {
  if (confirm("Delete the locally stored GeoPDF?")) await clearAndDelete();
});

els.mapViewport.addEventListener("pointerdown", pointerDown);
els.mapViewport.addEventListener("pointermove", pointerMove);
els.mapViewport.addEventListener("pointerup", pointerUp);
els.mapViewport.addEventListener("pointercancel", pointerUp);
els.mapViewport.addEventListener("wheel", (e) => {
  if (!state.viewport) return;
  e.preventDefault();
  zoomBy(e.deltaY < 0 ? 1.12 : 0.88);
}, { passive: false });

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Service worker registration failed", error));
}

setNetworkStatus();
startGps();
loadStoredPdf();
