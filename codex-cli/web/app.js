const el = {
  title: document.getElementById("title"),
  terminal: document.getElementById("terminal"),
  dropZone: document.getElementById("dropZone"),
  dropHint: document.getElementById("dropHint"),
  imagePanel: document.getElementById("imagePanel"),
  imagePreview: document.getElementById("imagePreview"),
  imagePath: document.getElementById("imagePath"),
  insertPath: document.getElementById("insertPath"),
  closeImagePanel: document.getElementById("closeImagePanel"),
  imageUploadPanel: document.getElementById("imageUploadPanel"),
  imageUploadForm: document.getElementById("imageUploadForm"),
  imageUploadFile: document.getElementById("imageUploadFile"),
  imageUploadState: document.getElementById("imageUploadState"),
  imageUploadSubmit: document.getElementById("imageUploadSubmit"),
  closeImageUploadPanel: document.getElementById("closeImageUploadPanel"),
  uploadAuth: document.getElementById("uploadAuth"),
  pasteImage: document.getElementById("pasteImage"),
  reloadYaml: document.getElementById("reloadYaml"),
  restartHa: document.getElementById("restartHa"),
  rateLimit: document.getElementById("rateLimit"),
  authPanel: document.getElementById("authPanel"),
  authUploadForm: document.getElementById("authUploadForm"),
  authState: document.getElementById("authState"),
  authFile: document.getElementById("authFile"),
  authPath: document.getElementById("authPath"),
  uploadAuthSubmit: document.getElementById("uploadAuthSubmit"),
  closeAuthPanel: document.getElementById("closeAuthPanel"),
  fontDown: document.getElementById("fontDown"),
  fontSizeValue: document.getElementById("fontSizeValue"),
  fontUp: document.getElementById("fontUp"),
  keyUp: document.getElementById("keyUp"),
  keyDown: document.getElementById("keyDown"),
  scrollUp: document.getElementById("scrollUp"),
  scrollLineUp: document.getElementById("scrollLineUp"),
  scrollLineDown: document.getElementById("scrollLineDown"),
  scrollDown: document.getElementById("scrollDown"),
  scrollBottom: document.getElementById("scrollBottom"),
  toast: document.getElementById("toast"),
  pasteCatcher: document.getElementById("pasteCatcher"),
};

const DEFAULT_FONT_SIZE = 14;
const FONT_SIZE_KEY = "codex-cli-ha-terminal-font-size";
const MIN_FONT_SIZE = 9;
const MAX_FONT_SIZE = 28;

const storedFontSize = readStoredFontSize();

const state = {
  socket: null,
  latestImage: null,
  terminalReady: false,
  pasteCaptureActive: false,
  pasteCaptureTimer: null,
  fontSize: storedFontSize || DEFAULT_FONT_SIZE,
  hasStoredFontSize: storedFontSize !== null,
  tmuxCopyModeActive: false,
};

const UPLOAD_IMAGE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const IMAGE_TYPE_ALIASES = new Map([
  ["image/jpg", "image/jpeg"],
  ["image/pjpeg", "image/jpeg"],
  ["image/x-png", "image/png"],
]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".avif", ".heic", ".heif"]);

const baseUrl = new URL(window.location.href);
if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname = `${baseUrl.pathname}/`;
baseUrl.search = "";
baseUrl.hash = "";

const term = new Terminal({
  cursorBlink: true,
  convertEol: true,
  fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
  fontSize: state.fontSize,
  theme: {
    background: "#111111",
    foreground: "#e1e1e1",
    cursor: "#03a9f4",
    selectionBackground: "#175a7a",
    black: "#111111",
    red: "#db4437",
    green: "#43a047",
    yellow: "#fdd835",
    blue: "#03a9f4",
    magenta: "#8e24aa",
    cyan: "#00bcd4",
    white: "#e1e1e1",
    brightBlack: "#727272",
    brightRed: "#ef5350",
    brightGreen: "#66bb6a",
    brightYellow: "#ffee58",
    brightBlue: "#29b6f6",
    brightMagenta: "#ab47bc",
    brightCyan: "#26c6da",
    brightWhite: "#ffffff",
  },
});

const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(el.terminal);
disableTerminalTextHelpers();
renderFontSize();
fit.fit();
term.attachCustomKeyEventHandler((event) => {
  if (event.type === "keydown" && event.altKey && event.key.toLowerCase() === "v") {
    event.preventDefault();
    requestImagePaste();
    return false;
  }
  return true;
});

function wsUrl(path) {
  const url = new URL(path, baseUrl);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

function apiUrl(path) {
  return new URL(path, baseUrl);
}

function disableTerminalTextHelpers() {
  const textarea = el.terminal.querySelector(".xterm-helper-textarea");
  if (!textarea) return;
  textarea.setAttribute("autocomplete", "off");
  textarea.setAttribute("autocorrect", "off");
  textarea.setAttribute("autocapitalize", "none");
  textarea.setAttribute("spellcheck", "false");
  textarea.spellcheck = false;
}

async function request(path, payload) {
  const response = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

async function requestForm(path, formData) {
  const response = await fetch(apiUrl(path), {
    method: "POST",
    body: formData,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function connectTerminal() {
  const socket = new WebSocket(wsUrl("ws"));
  state.socket = socket;

  socket.addEventListener("open", () => {
    state.terminalReady = true;
    resizeTerminal();
    showToast("Terminal connected");
  });

  socket.addEventListener("message", (event) => {
    term.write(event.data);
  });

  socket.addEventListener("close", () => {
    state.terminalReady = false;
    showToast("Terminal disconnected. Reconnecting...");
    window.setTimeout(connectTerminal, 1500);
  });

  socket.addEventListener("error", () => {
    showToast("Terminal websocket error");
  });
}

function sendTerminal(data) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify({ type: "input", data }));
  term.focus();
}

function sendTerminalControl(action) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify({ type: "control", action }));
  term.focus();
}

function sendUserInput(data) {
  if (state.tmuxCopyModeActive) {
    state.tmuxCopyModeActive = false;
    sendTerminalControl("scroll_bottom");
  }
  sendTerminal(data);
}

function resizeTerminal() {
  fit.fit();
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
}

term.onData((data) => sendUserInput(data));
window.addEventListener("resize", resizeTerminal);
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", resizeTerminal);
}

function readStoredFontSize() {
  try {
    const value = window.localStorage.getItem(FONT_SIZE_KEY);
    const parsed = Number.parseInt(value, 10);
    return validFontSize(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persistFontSize(size) {
  try {
    window.localStorage.setItem(FONT_SIZE_KEY, String(size));
  } catch {
    // Browser storage can be disabled in some embedded WebViews.
  }
}

function validFontSize(size) {
  return Number.isInteger(size) && size >= MIN_FONT_SIZE && size <= MAX_FONT_SIZE;
}

function clampFontSize(size) {
  const parsed = Number.parseInt(size, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_FONT_SIZE;
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, parsed));
}

function renderFontSize() {
  el.fontSizeValue.textContent = `${state.fontSize}px`;
  el.fontDown.disabled = state.fontSize <= MIN_FONT_SIZE;
  el.fontUp.disabled = state.fontSize >= MAX_FONT_SIZE;
}

function setTerminalFontSize(size, options = {}) {
  const nextSize = clampFontSize(size);
  state.fontSize = nextSize;
  term.options.fontSize = nextSize;
  if (options.persist) {
    state.hasStoredFontSize = true;
    persistFontSize(nextSize);
  }
  renderFontSize();
  window.requestAnimationFrame(resizeTerminal);
}

function showToast(message) {
  el.toast.textContent = message;
  el.toast.classList.remove("hidden");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => el.toast.classList.add("hidden"), 3500);
}

function openImageUploadPanel() {
  el.imageUploadPanel.classList.remove("hidden");
  el.imageUploadState.textContent = "No image selected.";
}

function closeImageUploadPanel() {
  el.imageUploadPanel.classList.add("hidden");
  el.imageUploadForm.reset();
  el.imageUploadSubmit.disabled = false;
  term.focus();
}

function normalizeImageType(type) {
  const mime = String(type || "").split(";", 1)[0].trim().toLowerCase();
  return IMAGE_TYPE_ALIASES.get(mime) || mime;
}

function fileExtension(name) {
  const match = String(name || "").toLowerCase().match(/\.[a-z0-9]+$/);
  return match ? match[0] : "";
}

function fileStem(name) {
  return String(name || "clipboard-image").replace(/\.[^.]*$/, "") || "clipboard-image";
}

function isLikelyImageFile(file) {
  const mime = normalizeImageType(file?.type);
  return mime.startsWith("image/") || IMAGE_EXTENSIONS.has(fileExtension(file?.name));
}

async function canvasToPngFile(canvas, name) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Browser could not convert pasted image to PNG");
  return new File([blob], `${fileStem(name)}.png`, { type: "image/png" });
}

async function convertImageToPng(file) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Browser canvas support is unavailable");

  if ("createImageBitmap" in window) {
    try {
      const bitmap = await createImageBitmap(file);
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      context.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      return canvasToPngFile(canvas, file.name);
    } catch {
      // Fall through to object URL decoding below.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error(`Unsupported pasted image type: ${file.type || "unknown"}`));
      element.src = url;
    });
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    context.drawImage(image, 0, 0);
    return canvasToPngFile(canvas, file.name);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function normalizeImageForUpload(file) {
  const mime = normalizeImageType(file.type);
  if (UPLOAD_IMAGE_TYPES.has(mime)) {
    if (mime === file.type) return { file, type: mime };
    const name = file.name || `clipboard-${Date.now()}`;
    return { file: new File([file], name, { type: mime }), type: mime };
  }
  const converted = await convertImageToPng(file);
  return { file: converted, type: "image/png" };
}

function insertImagePath(image) {
  if (!image) return;
  sendTerminal(image.path);
  el.imagePanel.classList.add("hidden");
  showToast("Image path inserted");
  request("api/image/cleanup", { name: image.name }).catch(() => {});
}

async function uploadImage(file, options = {}) {
  const image = await normalizeImageForUpload(file);
  const formData = new FormData();
  formData.append("file", image.file, image.file.name || file.name || "pasted-image");
  formData.append("name", image.file.name || file.name || "pasted-image");
  formData.append("type", image.type);
  const response = await requestForm("api/upload", formData);
  state.latestImage = response.image;
  renderImagePanel(response.image);
  if (options.autoInsertPath) {
    insertImagePath(response.image);
    return;
  }
  showToast("Image ready. Press Insert Path to use it.");
}

function armPasteCapture(message) {
  state.pasteCaptureActive = true;
  window.clearTimeout(state.pasteCaptureTimer);
  el.pasteCatcher.textContent = "";
  el.pasteCatcher.focus({ preventScroll: true });
  state.pasteCaptureTimer = window.setTimeout(() => {
    state.pasteCaptureActive = false;
    term.focus();
  }, 15000);
  showToast(message);
}

async function requestImagePaste() {
  if (!navigator.clipboard?.read || !window.isSecureContext) {
    armPasteCapture("Image paste: Alt+V -> Ctrl+V -> Insert Path.");
    return;
  }
  await pasteImageFromClipboard(true, { autoInsertPath: true });
}

async function pasteImageFromClipboard(allowPasteFallback = false, options = {}) {
  try {
    const items = await navigator.clipboard.read();
    const files = [];
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith("image/"));
      if (!imageType) continue;
      const blob = await item.getType(imageType);
      files.push(new File([blob], `clipboard-${Date.now()}.${imageType.split("/")[1] || "png"}`, { type: imageType }));
    }
    if (!files.length) {
      showToast("Clipboard does not contain an image");
      return;
    }
    await handleFiles(files, options);
  } catch (error) {
    if (allowPasteFallback) {
      armPasteCapture("Clipboard read was blocked. Use Alt+V -> Ctrl+V -> Insert Path.");
      return;
    }
    showToast(`Browser clipboard read failed: ${error.message}`);
  }
}

function renderImagePanel(image) {
  el.imagePanel.classList.remove("hidden");
  const cleanup = image.cleanupAfterSeconds ? ` Deleted ${image.cleanupAfterSeconds}s after Insert Path.` : "";
  el.imagePath.textContent = `${image.path}${cleanup}`;
  el.imagePreview.src = apiUrl(`api/image/${encodeURIComponent(image.name)}`);
}

function collectImageFilesFromPaste(event) {
  const files = [];
  for (const item of Array.from(event.clipboardData?.items || [])) {
    if (item.kind === "file" && normalizeImageType(item.type).startsWith("image/")) {
      const file = item.getAsFile();
      if (file && isLikelyImageFile(file)) files.push(file);
    }
  }
  for (const file of Array.from(event.clipboardData?.files || [])) {
    if (isLikelyImageFile(file) && !files.includes(file)) {
      files.push(file);
    }
  }
  return files;
}

async function handleFiles(files, options = {}) {
  const images = Array.from(files || []).filter(isLikelyImageFile);
  if (!images.length) return;
  for (const image of images) {
    await uploadImage(image, options);
  }
}

document.addEventListener("paste", (event) => {
  const files = collectImageFilesFromPaste(event);
  if (!files.length) {
    if (state.pasteCaptureActive) {
      state.pasteCaptureActive = false;
      window.clearTimeout(state.pasteCaptureTimer);
      showToast("Clipboard does not contain an image.");
      term.focus();
    }
    return;
  }
  event.preventDefault();
  state.pasteCaptureActive = false;
  window.clearTimeout(state.pasteCaptureTimer);
  handleFiles(files).catch((error) => showToast(error.message));
}, true);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !el.imageUploadPanel.classList.contains("hidden")) {
    closeImageUploadPanel();
  }
});

el.dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  el.dropZone.classList.add("dragging");
});

el.dropZone.addEventListener("dragleave", () => el.dropZone.classList.remove("dragging"));

el.dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  el.dropZone.classList.remove("dragging");
  handleFiles(event.dataTransfer.files).catch((error) => showToast(error.message));
});

el.insertPath.addEventListener("click", () => {
  insertImagePath(state.latestImage);
});

el.closeImagePanel.addEventListener("click", () => el.imagePanel.classList.add("hidden"));

el.imageUploadFile.addEventListener("change", () => {
  const files = Array.from(el.imageUploadFile.files || []);
  const images = files.filter(isLikelyImageFile);
  if (!files.length) {
    el.imageUploadState.textContent = "No image selected.";
  } else if (!images.length) {
    el.imageUploadState.textContent = "Choose an image file.";
  } else {
    el.imageUploadState.textContent = images[0].name || "Image selected.";
  }
});

el.imageUploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  el.imageUploadSubmit.disabled = true;
  try {
    const file = Array.from(el.imageUploadFile.files || []).find(isLikelyImageFile);
    if (!file) {
      throw new Error("Choose an image file first.");
    }
    el.imageUploadState.textContent = `Uploading ${file.name || "image"}...`;
    await uploadImage(file);
    closeImageUploadPanel();
  } catch (error) {
    el.imageUploadState.textContent = error.message;
    el.imageUploadSubmit.disabled = false;
  }
});

el.closeImageUploadPanel.addEventListener("click", () => closeImageUploadPanel());

el.imageUploadPanel.addEventListener("click", (event) => {
  if (event.target === el.imageUploadPanel) {
    closeImageUploadPanel();
  }
});

function renderAuth(auth) {
  if (auth?.type === "authJson") {
    el.authState.textContent = `auth.json uploaded to ${auth.path}`;
  } else {
    el.authState.textContent = JSON.stringify(auth || {});
  }
}

el.uploadAuth.addEventListener("click", () => {
  el.authPanel.classList.remove("hidden");
  el.authState.textContent = "Choose auth.json and upload it.";
});

el.pasteImage.addEventListener("click", () => openImageUploadPanel());

el.reloadYaml.addEventListener("click", async () => {
  el.reloadYaml.disabled = true;
  try {
    await request("api/ha/reload-yaml", {});
    showToast("Home Assistant YAML reload requested");
  } catch (error) {
    showToast(error.message);
  } finally {
    el.reloadYaml.disabled = false;
  }
});

el.restartHa.addEventListener("click", async () => {
  if (!window.confirm("Restart Home Assistant Core now?")) return;
  el.restartHa.disabled = true;
  try {
    await request("api/ha/restart", {});
    showToast("Home Assistant restart requested");
  } catch (error) {
    showToast(error.message);
    el.restartHa.disabled = false;
  }
});

el.authUploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  el.authPanel.classList.remove("hidden");
  el.uploadAuthSubmit.disabled = true;
  try {
    const file = el.authFile.files?.[0];
    if (!file) {
      throw new Error("Choose an auth.json file first.");
    }
    el.authState.textContent = `Uploading ${file.name}...`;
    const formData = new FormData();
    formData.append("file", file, file.name || "auth.json");
    formData.append("name", file.name || "auth.json");
    const response = await requestForm("api/auth/upload", formData);
    const restarted = response.result.terminalRestarted ? " Terminal session restarted." : "";
    el.authState.textContent = `auth.json uploaded to ${response.result.path}.${restarted}`;
    el.authFile.value = "";
    refreshRateLimit();
  } catch (error) {
    el.authState.textContent = error.message;
  } finally {
    el.uploadAuthSubmit.disabled = false;
  }
});

el.closeAuthPanel.addEventListener("click", () => el.authPanel.classList.add("hidden"));

el.fontDown.addEventListener("click", () => setTerminalFontSize(state.fontSize - 1, { persist: true }));
el.fontUp.addEventListener("click", () => setTerminalFontSize(state.fontSize + 1, { persist: true }));

el.keyUp.addEventListener("click", () => sendUserInput("\x1b[A"));
el.keyDown.addEventListener("click", () => sendUserInput("\x1b[B"));

el.scrollUp.addEventListener("click", () => {
  term.scrollPages(-1);
  state.tmuxCopyModeActive = true;
  sendTerminalControl("scroll_up");
  term.focus();
});

el.scrollLineUp.addEventListener("click", () => {
  term.scrollLines(-1);
  state.tmuxCopyModeActive = true;
  sendTerminalControl("scroll_line_up");
  term.focus();
});

el.scrollLineDown.addEventListener("click", () => {
  term.scrollLines(1);
  state.tmuxCopyModeActive = true;
  sendTerminalControl("scroll_line_down");
  term.focus();
});

el.scrollDown.addEventListener("click", () => {
  term.scrollPages(1);
  state.tmuxCopyModeActive = true;
  sendTerminalControl("scroll_down");
  term.focus();
});

el.scrollBottom.addEventListener("click", () => {
  term.scrollToBottom();
  state.tmuxCopyModeActive = false;
  sendTerminalControl("scroll_bottom");
  term.focus();
});

async function refreshRateLimit() {
  try {
    const response = await fetch(apiUrl("api/rate-limits")).then((item) => item.json());
    if (!response.ok) throw new Error(response.error || "Rate limit unavailable");
    el.rateLimit.textContent = response.result.summary || "Rate limit: unavailable";
  } catch (error) {
    el.rateLimit.textContent = "Rate limit: unavailable";
  }
}

fetch(apiUrl("api/state"))
  .then((response) => response.json())
  .then((snapshot) => {
    el.title.textContent = "Codex CLI";
    el.rateLimit.textContent = snapshot.rateLimitsSummary || "Rate limit: loading...";
    if (!state.hasStoredFontSize) {
      setTerminalFontSize(snapshot.fontSize || DEFAULT_FONT_SIZE);
    } else {
      setTerminalFontSize(state.fontSize);
    }
    if (snapshot.authPath) {
      el.authPath.textContent = `Target path: ${snapshot.authPath}`;
    }
    if (snapshot.auth) {
      el.authPanel.classList.remove("hidden");
      renderAuth(snapshot.auth);
    }
    resizeTerminal();
  })
  .catch(() => {
    el.title.textContent = "Codex CLI";
    el.rateLimit.textContent = "Rate limit: unavailable";
  });

connectTerminal();
refreshRateLimit();
window.setInterval(refreshRateLimit, 60000);
term.focus();
