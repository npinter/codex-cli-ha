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
  copySelection: document.getElementById("copySelection"),
  copyScreen: document.getElementById("copyScreen"),
  showLinks: document.getElementById("showLinks"),
  linkPanel: document.getElementById("linkPanel"),
  linkList: document.getElementById("linkList"),
  closeLinkPanel: document.getElementById("closeLinkPanel"),
  loginChatgpt: document.getElementById("loginChatgpt"),
  loginDevice: document.getElementById("loginDevice"),
  loginStatus: document.getElementById("loginStatus"),
  authPanel: document.getElementById("authPanel"),
  authState: document.getElementById("authState"),
  callbackUrl: document.getElementById("callbackUrl"),
  forwardCallback: document.getElementById("forwardCallback"),
  closeAuthPanel: document.getElementById("closeAuthPanel"),
  toast: document.getElementById("toast"),
};

const state = {
  socket: null,
  latestImage: null,
  terminalReady: false,
  links: [],
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
if (window.WebLinksAddon?.WebLinksAddon) {
  term.loadAddon(
    new WebLinksAddon.WebLinksAddon((event, uri) => {
      event.preventDefault();
      openLink(uri);
    }),
  );
}
term.open(el.terminal);
fit.fit();

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
    collectLinks(event.data);
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

async function copyText(text, emptyMessage) {
  if (!text) {
    showToast(emptyMessage);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast("Copied");
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    showToast("Copied");
  }
}

function getScreenText() {
  const buffer = term.buffer.active;
  const lines = [];
  const start = Math.max(0, buffer.baseY);
  const end = buffer.baseY + buffer.rows;
  for (let index = start; index < end; index += 1) {
    const line = buffer.getLine(index);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n").trim();
}

function collectLinks(text) {
  const matches = String(text).match(/https?:\/\/[^\s<>"')\]]+/g) || [];
  for (const raw of matches) {
    const url = raw.replace(/[.,;:!?]+$/, "");
    if (!state.links.some((item) => item.url === url)) {
      state.links.unshift({ url, time: Date.now() });
    }
  }
  state.links = state.links.slice(0, 20);
  renderLinks();
}

function renderLinks() {
  if (!state.links.length) {
    el.linkList.innerHTML = '<p class="hint">No links detected yet.</p>';
    return;
  }
  el.linkList.innerHTML = state.links
    .map((item) => `
      <div class="link-row">
        <a href="${escapeAttribute(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.url)}</a>
        <button type="button" data-copy-link="${escapeAttribute(item.url)}">Copy</button>
      </div>
    `)
    .join("");
}

function openLink(url) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
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
  sendTerminal(response.image.path);
  showToast(`Image saved: ${response.image.name}`);
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

el.copySelection.addEventListener("click", () => {
  copyText(term.getSelection(), "No terminal text selected");
});

el.copyScreen.addEventListener("click", () => {
  copyText(getScreenText(), "Terminal screen is empty");
});

el.showLinks.addEventListener("click", () => {
  renderLinks();
  el.linkPanel.classList.remove("hidden");
});

el.closeLinkPanel.addEventListener("click", () => el.linkPanel.classList.add("hidden"));

el.linkList.addEventListener("click", (event) => {
  const url = event.target.dataset.copyLink;
  if (!url) return;
  copyText(url, "No link");
});

async function startAuth(type) {
  el.authPanel.classList.remove("hidden");
  el.authState.textContent = "Starting login...";
  try {
    const response = await request("api/auth/start", { type });
    renderAuth(response.result);
  } catch (error) {
    el.authState.textContent = error.message;
  }
}

function renderAuth(auth) {
  if (auth?.authUrl) {
    el.authState.innerHTML = `<a href="${auth.authUrl}" target="_blank" rel="noreferrer">Open ChatGPT login</a><br>After sign-in, paste the full failed <code>http://localhost:port/...</code> URL from the browser address bar below.`;
    window.open(auth.authUrl, "_blank", "noreferrer");
  } else if (auth?.verificationUrl) {
    el.authState.innerHTML = `<a href="${auth.verificationUrl}" target="_blank" rel="noreferrer">Open device login</a><br>Code: <strong>${auth.userCode || ""}</strong>`;
  } else {
    el.authState.textContent = JSON.stringify(auth || {});
  }
}

el.loginChatgpt.addEventListener("click", () => startAuth("chatgpt"));
el.loginDevice.addEventListener("click", () => startAuth("chatgptDeviceCode"));

el.loginStatus.addEventListener("click", async () => {
  el.authPanel.classList.remove("hidden");
  const response = await fetch(apiUrl("api/auth/status")).then((item) => item.json());
  el.authState.textContent = `${response.status.stdout || ""}${response.status.stderr || ""}`.trim() || `exit ${response.status.code}`;
});

el.forwardCallback.addEventListener("click", async () => {
  try {
    const url = el.callbackUrl.value.trim();
    if (!/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+\//.test(url)) {
      throw new Error("Paste the full callback URL starting with http://localhost:<port>/, not just code/state text.");
    }
    const response = await request("api/auth/callback", { url });
    el.authState.textContent = `Callback forwarded. HTTP ${response.result.status}`;
    el.callbackUrl.value = "";
  } catch (error) {
    el.authState.textContent = error.message;
  }
});

el.closeAuthPanel.addEventListener("click", () => el.authPanel.classList.add("hidden"));

fetch(apiUrl("api/state"))
  .then((response) => response.json())
  .then((snapshot) => {
    el.meta.textContent = `Workspace: ${snapshot.workspace} | Images: ${snapshot.imageDir}`;
    term.options.fontSize = snapshot.fontSize || 14;
    resizeTerminal();
  })
  .catch(() => {
    el.meta.textContent = "State unavailable";
  });

connectTerminal();
term.focus();
