const el = {
  meta: document.getElementById("meta"),
  terminal: document.getElementById("terminal"),
  dropZone: document.getElementById("dropZone"),
  dropHint: document.getElementById("dropHint"),
  imagePanel: document.getElementById("imagePanel"),
  imagePath: document.getElementById("imagePath"),
  imagePrompt: document.getElementById("imagePrompt"),
  insertPath: document.getElementById("insertPath"),
  runImage: document.getElementById("runImage"),
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
  toast: document.getElementById("toast"),
};

const state = {
  socket: null,
  latestImage: null,
  terminalReady: false,
};

const baseUrl = new URL(window.location.href);
if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname = `${baseUrl.pathname}/`;
baseUrl.search = "";
baseUrl.hash = "";

const term = new Terminal({
  cursorBlink: true,
  convertEol: true,
  fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
  fontSize: 14,
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
fit.fit();
term.attachCustomKeyEventHandler((event) => {
  if (event.type === "keydown" && event.altKey && event.key.toLowerCase() === "v") {
    event.preventDefault();
    pasteImageFromClipboard();
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

function resizeTerminal() {
  fit.fit();
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
}

term.onData((data) => sendTerminal(data));
window.addEventListener("resize", resizeTerminal);

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function showToast(message) {
  el.toast.textContent = message;
  el.toast.classList.remove("hidden");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => el.toast.classList.add("hidden"), 3500);
}

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function uploadImage(file) {
  const data = await fileToBase64(file);
  const response = await request("api/upload", {
    name: file.name || "pasted-image",
    type: file.type,
    data,
  });
  state.latestImage = response.image;
  renderImagePanel(response.image);
  sendTerminal(`Image pasted: ${response.image.path}`);
  showToast(`Image saved: ${response.image.name}`);
}

async function pasteImageFromClipboard() {
  if (!navigator.clipboard?.read) {
    showToast("Browser clipboard image access is unavailable. Use normal paste or drop.");
    return;
  }
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
    await handleFiles(files);
  } catch (error) {
    showToast(`Browser clipboard read failed: ${error.message}`);
  }
}

function renderImagePanel(image) {
  el.imagePanel.classList.remove("hidden");
  el.imagePath.textContent = image.path;
}

function collectImageFilesFromPaste(event) {
  const files = [];
  for (const item of Array.from(event.clipboardData?.items || [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

async function handleFiles(files) {
  const images = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
  if (!images.length) return;
  for (const image of images) {
    await uploadImage(image);
  }
}

document.addEventListener("paste", (event) => {
  const files = collectImageFilesFromPaste(event);
  if (!files.length) return;
  event.preventDefault();
  handleFiles(files).catch((error) => showToast(error.message));
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
  if (!state.latestImage) return;
  sendTerminal(state.latestImage.path);
});

el.runImage.addEventListener("click", () => {
  if (!state.latestImage) return;
  const prompt = el.imagePrompt.value.trim();
  const command = prompt
    ? `codex-image ${shellQuote(state.latestImage.path)} ${shellQuote(prompt)}\r`
    : `codex-image ${shellQuote(state.latestImage.path)}\r`;
  sendTerminal(command);
});

el.closeImagePanel.addEventListener("click", () => el.imagePanel.classList.add("hidden"));

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

el.pasteImage.addEventListener("click", () => pasteImageFromClipboard());

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
    const data = await fileToBase64(file);
    el.authState.textContent = `Uploading ${file.name}...`;
    const response = await request("api/auth/upload", { name: file.name, data });
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
    el.meta.textContent = `Version: ${snapshot.version || "unknown"} | Workspace: ${snapshot.workspace} | Images: ${snapshot.imageDir}`;
    el.rateLimit.textContent = snapshot.rateLimitsSummary || "Rate limit: loading...";
    term.options.fontSize = snapshot.fontSize || 14;
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
    el.meta.textContent = "State unavailable";
  });

connectTerminal();
refreshRateLimit();
window.setInterval(refreshRateLimit, 60000);
term.focus();
