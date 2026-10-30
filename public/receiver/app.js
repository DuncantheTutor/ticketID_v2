import { api } from "/net.js";

window.TICKETID_ACTOR = "receiver";
const tokenKey = "ticketid.receiver";
const pinKey = "ticketid.scanner.pin";
const lockKey = "ticketid.scanner.locked";
const app = document.querySelector("#app");
let token = localStorage.getItem(tokenKey);
let locked = localStorage.getItem(lockKey) === "1";
let image = "";
let eventName = "";
let mode = "scan";
let facing = "environment";
let error = "";
let stream = null;
let joinStream = null;
let attempt = 0;
let joinAttempt = 0;
let busy = false;
let joining = false;
let store = "";
let heldCode = "";
let heldUntil = 0;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function padlock(closed) {
  const shackle = closed
    ? `<path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`
    : `<path d="M8 11V8a4 4 0 0 1 7.4-2.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`;
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.7"/>${shackle}</svg>`;
}

function appleIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.2 12.5c0-2.1 1.7-3.1 1.8-3.2-1-.1.4-1.6-3.1-1.6-1.3 0-2.5.8-3.1.8-.7 0-1.6-.7-2.7-.7-1.4 0-2.7.8-3.4 2.1-1.5 2.5-.4 6.3 1 8.4.7 1 1.5 2.1 2.6 2.1 1 0 1.4-.7 2.7-.7s1.6.7 2.7.7 1.8-1 2.5-2c.8-1.1 1.1-2.2 1.1-2.3-.1 0-2.1-.8-2.1-3.6zM14.5 6.5c.5-.7.9-1.6.8-2.5-.8.1-1.8.6-2.3 1.2-.5.6-1 1.6-.8 2.5.9 0 1.8-.5 2.3-1.2z"/></svg>`;
}

function playIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 4.2v15.6l12.2-7.8L6 4.2z"/></svg>`;
}

function cameraIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.2 8.4h1.1l.7-1.2h3.2l.7 1.2h1.9a1.3 1.3 0 0 1 1.3 1.3v4.6a1.3 1.3 0 0 1-1.3 1.3H8.2a1.3 1.3 0 0 1-1.3-1.3V9.7a1.3 1.3 0 0 1 1.3-1.3Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="11.2" r="1.7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M16.7 16.4a6.3 6.3 0 0 1-9.6-.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M6.4 14.2 7.2 16.8 9.7 15.7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.3 7.6a6.3 6.3 0 0 1 9.6.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M17.6 9.8 16.8 7.2 14.3 8.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

let sessionWatch = 0;

function signedOut() {
  stopCamera();
  localStorage.removeItem(tokenKey);
  localStorage.removeItem(lockKey);
  token = null;
  locked = false;
  image = "";
  eventName = "";
  mode = "scan";
  busy = false;
  error = "This phone was signed out.";
  render();
}

function watchSession(active) {
  clearInterval(sessionWatch);
  sessionWatch = 0;
  if (!active) return;
  sessionWatch = setInterval(async () => {
    if (!token) return;
    try {
      await api("/api/receiver/event", { token });
    } catch (cause) {
      if (cause.status === 401) signedOut();
    }
  }, 4000);
}

function render() {
  watchSession(Boolean(token));
  if (!token) {
    stopCamera();
    locked = false;
    localStorage.removeItem(lockKey);
    if (joining) {
      app.innerHTML = `<section class="poster">
        <button class="leave" type="button" aria-label="Back">×</button>
        <header class="mast">
          <p class="powered">ticket<span>ID</span><span class="role">Receiver</span></p>
          <h1 class="event-name">Scan code</h1>
        </header>
        <div class="finder-wrap"><div class="finder"><video autoplay playsinline muted disablepictureinpicture></video></div></div>
        <p class="scan-line">Point at the scanner code</p>
      </section>`;
      document.querySelector(".leave").addEventListener("click", () => {
        joining = false;
        stopJoin();
        render();
      });
      watchJoin();
      return;
    }
    stopJoin();
    app.innerHTML = `<main class="screen"><form class="stack" id="join">
      <div class="lockup"><p class="wordmark">ticket<span>ID</span></p><p class="role">Receiver</p></div>
      <h1>Join an event</h1>
      <label>Scanner code<input name="code" autocapitalize="characters" required></label>
      ${error ? `<p class="error">${esc(error)}</p>` : ""}
      <button class="primary" type="submit">Log in</button>
      <button class="ghost" id="scan-code" type="button">Scan Code</button>
    </form></main>`;
    document.querySelector("#join").addEventListener("submit", async (event) => {
      event.preventDefault();
      error = "";
      const form = new FormData(event.currentTarget);
      try {
        const result = await api("/api/receiver/login", { method: "POST", body: { code: form.get("code") } });
        token = result.token;
        image = result.image;
        eventName = result.name || "";
        localStorage.setItem(tokenKey, token);
        mode = "scan";
        joining = false;
        render();
      } catch (cause) {
        error = cause.message;
        joining = false;
        render();
      }
    });
    document.querySelector("#scan-code").addEventListener("click", () => {
      error = "";
      joining = true;
      render();
    });
    return;
  }
  stopJoin();
  if (mode === "success") {
    stopCamera();
    app.innerHTML = `<section class="poster is-success${locked ? " is-locked" : ""}" style="background-image:url('${esc(image)}')">
      ${chrome()}
      <div class="success-pop" role="status"><p>Successfully registered at ${esc(eventName)}</p></div>
    </section>`;
    bindChrome();
    return;
  }
  app.innerHTML = `<section class="poster${locked ? " is-locked" : ""}" style="background-image:url('${esc(image)}')">
    ${chrome()}
    <header class="mast">
      <p class="powered">ticket<span>ID</span><span class="role">Receiver</span></p>
    </header>
    <div class="finder-wrap">
      <h1 class="event-name">${esc(eventName)}</h1>
      <div class="finder">
        <video autoplay playsinline muted disablepictureinpicture></video>
        <div class="store-reveal">${storeQrHtml()}</div>
      </div>
    </div>
    <div class="scan-foot">
      <p class="scan-line">Scan to register</p>
      <div class="get-app">
        <p>Get the app</p>
        <div class="store-row">
          <button type="button" data-store="apple" aria-label="App Store" aria-pressed="${store === "apple"}">${appleIcon()}</button>
          <button type="button" data-store="google" aria-label="Google Play" aria-pressed="${store === "google"}">${playIcon()}</button>
        </div>
      </div>
    </div>
  </section>`;
  bindChrome();
  startCamera();
}

function storeQrHtml() {
  return store && storeQr ? `<img alt="${store === "apple" ? "App Store" : "Google Play"}" src="${esc(storeQr)}">` : "";
}

let storeQr = "";

function chrome() {
  return `<button class="leave" type="button" aria-label="Leave event">×</button>
    <button class="lock" type="button" id="lock" aria-label="${locked ? "Unlock" : "Lock"}">${padlock(locked)}</button>
    ${mode === "scan" ? `<button class="flip" type="button" id="flip" aria-label="Switch camera">${cameraIcon()}</button>` : ""}`;
}

function bindChrome() {
  document.querySelector(".leave")?.addEventListener("click", () => { if (!locked) leave(); });
  document.querySelector("#flip")?.addEventListener("click", () => {
    if (locked) return;
    facing = facing === "environment" ? "user" : "environment";
    startCamera();
  });
  document.querySelectorAll("[data-store]").forEach((button) => {
    button.addEventListener("click", () => openStore(button.dataset.store));
  });
  document.querySelector(".store-reveal")?.addEventListener("click", () => {
    if (store) openStore(store);
  });
  document.querySelector("#lock")?.addEventListener("click", () => {
    if (document.querySelector(".pin-pad")) {
      closePin();
      return;
    }
    if (!locked) {
      if (localStorage.getItem(pinKey)) setLocked(true);
      else openPin("set");
      return;
    }
    openPin("unlock");
  });
}

async function openStore(which) {
  const reveal = document.querySelector(".store-reveal");
  if (!reveal) return;
  if (store === which) {
    store = "";
    storeQr = "";
    reveal.innerHTML = "";
    document.querySelectorAll("[data-store]").forEach((button) => button.setAttribute("aria-pressed", "false"));
    return;
  }
  store = which;
  document.querySelectorAll("[data-store]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.store === which)));
  try {
    const result = await api(`/api/store-qr?store=${which}`);
    if (store !== which) return;
    storeQr = result.qr;
    reveal.innerHTML = storeQrHtml();
  } catch (cause) {
    store = "";
    storeQr = "";
    reveal.textContent = cause.message;
  }
}

function setLocked(next) {
  locked = next;
  if (next) localStorage.setItem(lockKey, "1");
  else localStorage.removeItem(lockKey);
  document.querySelector(".poster")?.classList.toggle("is-locked", locked);
  const button = document.querySelector("#lock");
  if (button) {
    button.setAttribute("aria-label", locked ? "Unlock" : "Lock");
    button.innerHTML = padlock(locked);
  }
}

function openPin(step) {
  closePin();
  const poster = document.querySelector(".poster");
  if (!poster) return;
  const pad = document.createElement("div");
  pad.className = "pin-pad";
  pad.dataset.step = step;
  pad.dataset.draft = "";
  pad.dataset.first = "";
  poster.append(pad);
  drawPin(pad);
}

function drawPin(pad) {
  const step = pad.dataset.step;
  const draft = pad.dataset.draft || "";
  const title = step === "set" ? "Choose a 4-digit PIN for this device" : step === "confirm" ? "Enter that PIN again" : "Enter the device PIN";
  pad.innerHTML = `<p class="pin-title">${esc(title)}</p>
    <p class="pin-dots" aria-hidden="true">${"●".repeat(draft.length)}${"○".repeat(4 - draft.length)}</p>
    <div class="pin-keys">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((digit) => `<button type="button" data-digit="${digit}">${digit}</button>`).join("")}</div>
    ${pad.dataset.error ? `<p class="error">${esc(pad.dataset.error)}</p>` : ""}`;
  pad.querySelectorAll("[data-digit]").forEach((button) => button.addEventListener("click", () => pressPin(pad, button.dataset.digit)));
}

function pressPin(pad, digit) {
  if ((pad.dataset.draft || "").length >= 4) return;
  pad.dataset.draft += digit;
  pad.dataset.error = "";
  if (pad.dataset.draft.length < 4) {
    drawPin(pad);
    return;
  }
  const entered = pad.dataset.draft;
  if (pad.dataset.step === "set") {
    pad.dataset.first = entered;
    pad.dataset.draft = "";
    pad.dataset.step = "confirm";
    drawPin(pad);
    return;
  }
  if (pad.dataset.step === "confirm") {
    if (entered !== pad.dataset.first) {
      pad.dataset.step = "set";
      pad.dataset.draft = "";
      pad.dataset.first = "";
      pad.dataset.error = "Those PINs did not match.";
      drawPin(pad);
      return;
    }
    localStorage.setItem(pinKey, entered);
    closePin();
    setLocked(true);
    return;
  }
  if (entered !== localStorage.getItem(pinKey)) {
    pad.dataset.draft = "";
    pad.dataset.error = "That PIN is not right.";
    drawPin(pad);
    return;
  }
  closePin();
  setLocked(false);
}

function closePin() {
  document.querySelector(".pin-pad")?.remove();
}

function stopCamera() {
  attempt += 1;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
}

function stopJoin() {
  joinAttempt += 1;
  joinStream?.getTracks().forEach((track) => track.stop());
  joinStream = null;
}

async function acceptJoin(raw) {
  const result = await api("/api/receiver/login", { method: "POST", body: { code: raw } });
  token = result.token;
  image = result.image;
  eventName = result.name || "";
  localStorage.setItem(tokenKey, token);
  joining = false;
  mode = "scan";
  render();
}

const scanCanvas = document.createElement("canvas");
const scanCtx = scanCanvas.getContext("2d", { willReadFrequently: true });

function readQr(video) {
  if (typeof jsQR !== "function" || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return "";
  const width = video.videoWidth;
  const height = video.videoHeight;
  const size = Math.min(width, height);
  const out = Math.min(size, 640);
  scanCanvas.width = out;
  scanCanvas.height = out;
  scanCtx.drawImage(video, (width - size) / 2, (height - size) / 2, size, size, 0, 0, out, out);
  const image = scanCtx.getImageData(0, 0, out, out);
  return jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" })?.data || "";
}

function scanFrames(video, running, onCode) {
  const loop = async () => {
    if (!running()) return;
    try {
      const raw = readQr(video);
      if (raw && running()) {
        const stop = await onCode(raw);
        if (stop || !running()) return;
      }
    } catch { /* keep the camera up until a code is read */ }
    if (running()) setTimeout(loop, 200);
  };
  loop();
}

async function openStream(which) {
  const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
  try {
    return await navigator.mediaDevices.getUserMedia({ video: { ...size, facingMode: { ideal: which } }, audio: false });
  } catch {
    return navigator.mediaDevices.getUserMedia({ video: size, audio: false });
  }
}

function showScanNote(message) {
  const line = document.querySelector(".scan-line");
  if (!line) return;
  line.textContent = message;
  setTimeout(() => {
    if (line.isConnected && mode === "scan" && line.textContent === message) line.textContent = "Scan to register";
  }, 3000);
}

async function watchJoin() {
  const video = document.querySelector("video");
  if (!video) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof jsQR !== "function") {
    error = "This browser cannot scan a code.";
    joining = false;
    render();
    return;
  }
  const mine = ++joinAttempt;
  joinStream?.getTracks().forEach((track) => track.stop());
  joinStream = null;
  try {
    joinStream = await openStream("environment");
    if (mine !== joinAttempt || token || !joining) {
      joinStream.getTracks().forEach((track) => track.stop());
      return;
    }
    video.srcObject = joinStream;
    await video.play().catch(() => undefined);
    scanFrames(video, () => mine === joinAttempt && !token && joining, async (raw) => {
      if (!/^ticketid:[A-Za-z0-9]+$/i.test(raw)) return false;
      try {
        await acceptJoin(raw);
      } catch (cause) {
        error = cause.message;
        joining = false;
        render();
      }
      return true;
    });
  } catch {
    error = "The camera could not be opened.";
    joining = false;
    render();
  }
}

async function startCamera() {
  const video = document.querySelector("video");
  if (!video || mode !== "scan") return;
  const mine = ++attempt;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.classList.toggle("mirror", facing === "user");
  if (!navigator.mediaDevices?.getUserMedia || typeof jsQR !== "function") {
    showScanNote("This browser cannot scan a code.");
    return;
  }
  try {
    stream = await openStream(facing);
    if (mine !== attempt) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    video.srcObject = stream;
    await video.play().catch(() => undefined);
    scanFrames(video, () => mine === attempt && mode === "scan", redeem);
  } catch {
    if (mine === attempt) showScanNote("The camera could not be opened.");
  }
}

async function redeem(raw) {
  const code = String(raw ?? "").trim();
  if (!code || busy || mode !== "scan") return false;
  if (code === heldCode && Date.now() < heldUntil) return false;
  busy = true;
  try {
    await api("/api/receiver/scan", { method: "POST", token, body: { code } });
    heldCode = "";
    mode = "success";
    render();
    setTimeout(() => {
      if (mode !== "success") return;
      mode = "scan";
      busy = false;
      render();
    }, 4000);
    return true;
  } catch (cause) {
    if (cause.status === 401) {
      signedOut();
      return false;
    }
    busy = false;
    heldCode = code;
    heldUntil = Date.now() + 3000;
    showScanNote(cause.message);
    return false;
  }
}

async function leave() {
  mode = "scan";
  busy = false;
  stopCamera();
  await api("/api/logout", { method: "POST", token, body: {} }).catch(() => undefined);
  localStorage.removeItem(tokenKey);
  localStorage.removeItem(lockKey);
  locked = false;
  token = null;
  image = "";
  eventName = "";
  render();
}

if (token) {
  api("/api/receiver/event", { token }).then((event) => {
    image = event.image;
    eventName = event.name || "";
    mode = "scan";
    render();
  }).catch(() => {
    localStorage.removeItem(tokenKey);
    token = null;
    render();
  });
} else {
  render();
}
