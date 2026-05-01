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
  startBrowserLogin: document.getElementById("startBrowserLogin"),
  startDeviceLogin: document.getElementById("startDeviceLogin"),
  cancelLogin: document.getElementById("cancelLogin"),
  authOpenLink: document.getElementById("authOpenLink"),
  deviceCode: document.getElementById("deviceCode"),
  fontDown: document.getElementById("fontDown"),
  fontSizeValue: document.getElementById("fontSizeValue"),
  fontUp: document.getElementById("fontUp"),
  keyUp: document.getElementById("keyUp"),
  keyDown: document.getElementById("keyDown"),
  scrollUp: document.getElementById("scrollUp"),
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
  authPollTimer: null,
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

function resetAuthDetails() {
  el.authOpenLink.classList.add("hidden");
  el.authOpenLink.removeAttribute("href");
  el.deviceCode.classList.add("hidden");
  el.deviceCode.textContent = "";
}

function setAuthPending(pending) {
  el.startBrowserLogin.disabled = pending;
  el.startDeviceLogin.disabled = pending;
  el.uploadAuthSubmit.disabled = pending;
  el.cancelLogin.classList.toggle("hidden", !pending);
}

function renderAuth(auth) {
  resetAuthDetails();
  const pending = auth?.type === "login" && auth.status === "pending";
  setAuthPending(pending);

  if (pending) {
    const directLogin = auth.loginType === "chatgpt";
    el.authState.textContent = directLogin ? "Complete sign-in in the browser tab." : "Enter the device code in the browser.";
    const url = auth.authUrl || auth.verificationUrl;
    if (url) {
      el.authOpenLink.href = url;
      el.authOpenLink.textContent = directLogin ? "Open sign-in page" : "Open device authorization";
      el.authOpenLink.classList.remove("hidden");
    }
    if (auth.userCode) {
      el.deviceCode.textContent = auth.userCode;
      el.deviceCode.classList.remove("hidden");
    }
    startAuthPolling();
    return;
  }

  stopAuthPolling();
  if (auth?.type === "completed") {
    if (auth.success) {
      const restarted = auth.terminalRestarted ? " Terminal session restarted." : "";
      el.authState.textContent = `Sign-in completed.${restarted}`;
      refreshRateLimit();
    } else {
      el.authState.textContent = auth.error || "Sign-in failed.";
    }
  } else if (auth?.type === "authJson") {
    const restarted = auth.restarted ? " Terminal session restarted." : "";
    el.authState.textContent = `auth.json uploaded to ${auth.path}.${restarted}`;
  } else if (auth?.type === "login" && auth.status) {
    el.authState.textContent = `Sign-in ${auth.status}.`;
  } else {
    el.authState.textContent = "Choose a sign-in method.";
  }
}

function startAuthPolling() {
  window.clearInterval(state.authPollTimer);
  state.authPollTimer = window.setInterval(refreshAuthState, 2500);
}

function stopAuthPolling() {
  window.clearInterval(state.authPollTimer);
  state.authPollTimer = null;
}

async function refreshAuthState() {
  const snapshot = await fetch(apiUrl("api/state")).then((response) => response.json());
  renderAuth(snapshot.auth);
}

async function startLogin(type) {
  el.authPanel.classList.remove("hidden");
  const pendingWindow = type === "chatgpt" ? window.open("about:blank", "_blank") : null;
  if (pendingWindow) {
    pendingWindow.opener = null;
  }
  setAuthPending(true);
  el.authState.textContent = type === "chatgpt" ? "Starting browser sign-in..." : "Starting device-code sign-in...";
  try {
    const response = await request("api/auth/login/start", { type });
    const auth = response.result;
    renderAuth(auth);
    const authUrl = auth.authUrl || auth.verificationUrl;
    if (pendingWindow && authUrl) {
      pendingWindow.location.href = authUrl;
    } else if (pendingWindow && !pendingWindow.closed) {
      pendingWindow.close();
    }
  } catch (error) {
    if (pendingWindow && !pendingWindow.closed) {
      pendingWindow.close();
    }
    setAuthPending(false);
    el.authState.textContent = error.message;
  }
}

el.uploadAuth.addEventListener("click", () => {
  el.authPanel.classList.remove("hidden");
  refreshAuthState().catch(() => renderAuth(null));
});

el.startBrowserLogin.addEventListener("click", () => startLogin("chatgpt"));

el.startDeviceLogin.addEventListener("click", () => startLogin("chatgptDeviceCode"));

el.cancelLogin.addEventListener("click", async () => {
  el.cancelLogin.disabled = true;
  try {
    const response = await request("api/auth/login/cancel", {});
    renderAuth(response.result);
  } catch (error) {
    el.authState.textContent = error.message;
  } finally {
    el.cancelLogin.disabled = false;
  }
});

el.pasteImage.addEventListener("click", () => requestImagePaste());

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
