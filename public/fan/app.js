import { api, forgetSession } from "/net.js";
import { gigDateLabel as dateLabel, gigWhen as eventWhen } from "/when.js";

window.TICKETID_ACTOR = "fan";
const tokenKey = "ticketid.fan";
const cacheKey = "ticketid.fan.cache";
const mediaCache = "ticketid-fan-media";

const app = document.querySelector("#app");
let token = localStorage.getItem(tokenKey);
let page = 0;
let menuOpen = false;
let panel = "";
const themeKey = "ticketid.theme";
let darkMode = localStorage.getItem(themeKey) === "dark";

function applyTheme() {
  document.body.dataset.theme = darkMode ? "dark" : "light";
}

applyTheme();
let me = null;
let gigs = [];
let codes = [];
let seenCodeIds = new Set();
let codesReady = false;
let codeTimer = 0;
let pushReady = false;
let live = null;
let confirmGig = null;
let authMode = "login";
let pendingEmail = sessionStorage.getItem("ticketid.pending") || "";
let recoverEmail = "";
let recoverContact = "";
let resetOob = "";
let resetFinished = false;

function resetLinkOpen() {
  const params = new URLSearchParams(location.search);
  const mode = params.get("mode") || "";
  if (mode && mode !== "resetPassword") return false;
  return location.pathname === "/reset" || Boolean(params.get("oobCode")) || Boolean(window.__ticketidReset);
}

function beginReset(code) {
  resetOob = String(code || "").trim();
  authMode = "link-reset";
  if (!resetOob) return;
  token = null;
  forgetSession();
  localStorage.removeItem(cacheKey);
}

function leaveReset() {
  resetOob = "";
  if (location.pathname === "/reset" || new URLSearchParams(location.search).has("oobCode")) history.replaceState(null, "", "/");
}

if (resetLinkOpen()) beginReset(new URLSearchParams(location.search).get("oobCode") || window.__ticketidReset || "");
window.addEventListener("ticketid-reset", (event) => {
  if (resetFinished) return;
  beginReset(event.detail);
  render();
});
let error = "";
let notice = "";
let dragX = null;
let picturePass = 0;
const pictureUrls = [];
let openCode = null;
let openEvent = null;
let openCodePage = null;
let offline = false;

function passwordRulesHtml() {
  return `<ul class="rules" aria-live="polite">
    <li data-rule="length">At least 8 characters</li>
    <li data-rule="capital">One capital letter</li>
    <li data-rule="number">One number</li>
    <li data-rule="symbol">One special character</li>
    <li data-rule="match">Both passwords match</li>
  </ul>`;
}

function watchPassword(form) {
  const password = form?.querySelector("[name=password]");
  const confirm = form?.querySelector("[name=confirm]");
  if (!password || !confirm) return;
  const paint = () => {
    const value = String(password.value || "");
    const flags = {
      length: value.length >= 8,
      capital: /[A-Z]/.test(value),
      number: /[0-9]/.test(value),
      symbol: /[^A-Za-z0-9]/.test(value),
      match: value.length > 0 && value === confirm.value,
    };
    form.querySelectorAll("[data-rule]").forEach((item) => item.classList.toggle("is-met", Boolean(flags[item.dataset.rule])));
  };
  password.addEventListener("input", paint);
  confirm.addEventListener("input", paint);
  paint();
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function passwordProblem(password) {
  const value = String(password ?? "");
  if (value.length < 8 || !/[A-Z]/.test(value) || !/[0-9]/.test(value) || !/[^A-Za-z0-9]/.test(value)) return "Use at least 8 characters, with one capital letter, one number, and one special character.";
  return "";
}

function expandIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H4v5M15 4h5v5M20 15v5h-5M4 15v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function remainLabel(iso) {
  const seconds = Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000));
  return `${seconds}s`;
}

function paintCountdown() {
  const node = document.querySelector("#qr-left");
  if (!node || !live?.expiresAt) return;
  node.textContent = remainLabel(live.expiresAt);
}

function wordmark() {
  return `<p class="wordmark">ticket<span>ID</span></p>`;
}

function brand(extra = "") {
  return `<header class="brand">${wordmark()}${extra}</header>`;
}

function dropPictures() {
  while (pictureUrls.length) URL.revokeObjectURL(pictureUrls.pop());
}

async function mediaBlob(url) {
  if ("caches" in window) {
    const cache = await caches.open(mediaCache);
    const hit = await cache.match(url);
    if (hit) return hit.blob();
    const response = await fetch(url);
    if (!response.ok) throw new Error("missing");
    await cache.put(url, response.clone()).catch(() => undefined);
    return response.blob();
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error("missing");
  return response.blob();
}

async function keepMedia(urls) {
  if (!("caches" in window)) return;
  const cache = await caches.open(mediaCache);
  for (const url of [...new Set(urls.filter(Boolean))]) {
    try {
      if (await cache.match(url)) continue;
      const response = await fetch(url);
      if (response.ok) await cache.put(url, response.clone());
    } catch {
      /* keep the last cached copy */
    }
  }
}

function paintPictures(pass) {
  for (const img of document.querySelectorAll("#app img")) {
    const src = img.getAttribute("src") || "";
    if (!/^https?:\/\//.test(src)) continue;
    img.addEventListener("error", async () => {
      if (pass !== picturePass || img.dataset.fetched === "1") return;
      img.dataset.fetched = "1";
      try {
        const blob = await mediaBlob(src);
        if (pass !== picturePass || blob.size < 32) return;
        const url = URL.createObjectURL(blob);
        pictureUrls.push(url);
        img.src = url;
      } catch {
        // The tile keeps its placeholder colour when the picture cannot be fetched.
      }
    }, { once: true });
  }
}

function render() {
  dropPictures();
  const params = new URLSearchParams(location.search);
  if (authMode === "link-reset") {
    app.innerHTML = linkResetForm();
    bindShell();
    return;
  }
  if (location.pathname === "/verify" || params.get("token")) {
    app.innerHTML = `<main class="screen auth">${brand()}<div class="stack"><p>Confirming your email.</p><p class="error">${esc(error)}</p></div></main>`;
    return;
  }
  if (!token) {
    const guest = pendingEmail ? verifyForm() : authMode === "signup" ? signupForm() : authMode === "recover" ? recoverForm() : loginForm();
    app.innerHTML = guest;
    bindShell();
    return;
  }
  if (panel) {
    app.innerHTML = panel === "settings" ? settingsForm() : panel === "password" ? passwordForm() : profileForm();
    bindShell();
    return;
  }
  app.innerHTML = `<div class="viewport${menuOpen ? " menu-open" : ""}">
    <header class="topbar brand">
      <p class="wordmark">ticket<span>ID</span></p>
      <nav class="tabs">
        <button type="button" data-page="0" ${page === 0 && !openEvent ? `aria-current="page"` : ""}>Home</button>
        <button type="button" data-page="1" ${page === 1 || openEvent ? `aria-current="page"` : ""}>Events</button>
        <button type="button" data-page="2" ${page === 2 || openCodePage ? `aria-current="page"` : ""}>Codes</button>
      </nav>
      <div class="menu">
        <button class="more" id="more" type="button" aria-label="Menu" aria-expanded="${menuOpen}"><span></span><span></span><span></span></button>
        ${menuOpen ? `<div class="dropdown" role="menu">
          <button type="button" data-menu="profile">Profile</button>
          <button type="button" data-menu="settings">Settings</button>
          <button type="button" data-menu="signout">Sign out</button>
        </div>` : ""}
      </div>
    </header>
    ${offline ? `<p class="offline">Showing what was saved on this phone. Some actions need a connection.</p>` : ""}
    ${menuOpen ? `<button class="menu-backdrop" id="close-menu" type="button" aria-label="Close menu"></button>` : ""}
    <div class="stage">
      ${openEvent ? eventPage() : openCodePage ? codeDetailPage() : `<div class="pager" style="transform: translateX(-${(page * 100) / 3}%)">
        ${qrPage()}
        ${gigsPage()}
        ${codesPage()}
      </div>`}
    </div>
    ${confirmGig ? `<div class="confirm"><div class="registered">
      <article class="tile">
        ${confirmGig.image ? `<img alt="" src="${esc(confirmGig.image)}">` : `<div class="fallback"></div>`}
        <p class="tile-name">${esc(confirmGig.gigName)}</p>
        ${confirmGig.startsAt ? `<span>${esc(dateLabel(confirmGig.startsAt))}</span>` : ""}
      </article>
      <p>Successfully registered at ${esc(confirmGig.gigName)}</p>
    </div></div>` : ""}
  </div>`;
  bindShell();
  paintPictures(++picturePass);
}

function loginForm() {
  return `<main class="screen auth">${brand()}<form class="stack" id="login">
    <label>Email<input name="email" type="email" autocomplete="username" required></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    ${notice ? `<p class="hint">${esc(notice)}</p>` : ""}
    <button class="primary" type="submit">Log in</button>
    <button class="ghost" type="button" id="forgot">Forgot password?</button>
    <button class="ghost" type="button" id="to-signup">Create an account</button>
  </form></main>`;
}

function signupForm() {
  return `<main class="screen auth">${brand()}<form class="stack" id="signup">
    <label>Username<input name="username" required></label>
    <label>Email<input name="email" type="email" required></label>
    <label>Phone<input name="phone" type="tel" required></label>
    <label>Password<input name="password" type="password" autocomplete="new-password" required></label>
    <label>Password again<input name="confirm" type="password" autocomplete="new-password" required></label>
    ${passwordRulesHtml()}
    <label>City<input name="city" autocomplete="address-level2"></label>
    <label>Country<input name="country" autocomplete="country-name"></label>
    <p class="hint">City and country are optional. If you leave them blank, you will get codes for upcoming events in your city and country if you add those details.</p>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <button class="primary" type="submit">Create account</button>
    <button class="ghost" type="button" id="to-login">I already have an account</button>
  </form></main>`;
}

function recoverForm() {
  return `<main class="screen auth">${brand()}<form class="stack" id="recover">
    <h1>Reset password</h1>
    <p>Enter the email or phone number on your account. We will email a link that opens ticketID so you can choose a new password.</p>
    <label>Email or phone<input name="contact" autocomplete="username" required></label>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <button class="primary" type="submit">Send link</button>
    <button class="ghost" type="button" id="to-login">Back to log in</button>
  </form></main>`;
}

function linkResetForm() {
  if (!resetOob) {
    return `<main class="screen auth">${brand()}<div class="stack">
      <h1>Reset password</h1>
      <p>This link does not include a reset code. Send a new one from the log in screen.</p>
      ${error ? `<p class="error">${esc(error)}</p>` : ""}
      <button class="primary" type="button" id="reset-again">Send a new link</button>
      <button class="ghost" type="button" id="to-login">Back to log in</button>
    </div></main>`;
  }
  return `<main class="screen auth">${brand()}<form class="stack" id="link-reset">
    <h1>Choose a new password</h1>
    <p>This link opened ticketID. Enter the new password twice.</p>
    <label>New password<input name="password" type="password" autocomplete="new-password" required></label>
    <label>New password again<input name="confirm" type="password" autocomplete="new-password" required></label>
    ${passwordRulesHtml()}
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <button class="primary" type="submit">Save password</button>
    <button class="ghost" type="button" id="reset-again">Send a new link</button>
    <button class="ghost" type="button" id="to-login">Back to log in</button>
  </form></main>`;
}

function verifyForm() {
  return `<main class="screen auth">${brand()}<form class="stack" id="verify">
    <p>We sent a message to ${esc(pendingEmail)}. Open the link, or enter the code from the email.</p>
    <label>Code<input name="code" autocomplete="one-time-code" required></label>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <button class="primary" type="submit">Confirm email</button>
    <button class="ghost" type="button" id="resend">Send the email again</button>
  </form></main>`;
}

function qrPage() {
  const body = live
    ? `<div class="qr-card"><img alt="One-time registration code" src="${live.qr}"><p class="qr-left" id="qr-left">${esc(remainLabel(live.expiresAt))}</p></div>`
    : `<button class="primary" type="button" id="generate">Press to generate code</button>`;
  return `<section class="page"><div class="generate">${body}${error && page === 0 ? `<p class="error">${esc(error)}</p>` : ""}</div></section>`;
}

function gigsPage() {
  if (!gigs.length) return `<section class="page"><p class="empty">Events you register at show up here.</p></section>`;
  return `<section class="page"><div class="tiles">${gigs.map((gig) => `<button class="tile" type="button" data-event="${esc(gig.id)}">
    ${gig.image ? `<img alt="" src="${esc(gig.image)}">` : `<div class="fallback"></div>`}
    <p class="tile-name">${esc(gig.name)}</p>
    <span>${esc(dateLabel(gig.startsAt))}</span>
  </button>`).join("")}</div></section>`;
}

function eventPage() {
  const gig = gigs.find((item) => item.id === openEvent);
  if (!gig) return `<section class="event"><p class="empty">That event is not on your list.</p></section>`;
  const people = (gig.members || []).map((member) => member.name).filter(Boolean);
  const note = gig.bio && gig.bio !== gig.tourName ? gig.bio : "";
  return `<article class="event">
    ${gig.image ? `<img alt="" src="${esc(gig.image)}">` : ""}
    <div class="stack">
      <h1>${esc(gig.name)}</h1>
      <p>${esc(eventWhen(gig.startsAt))}</p>
      ${people.length ? `<p>${esc(people.join(" · "))}</p>` : ""}
      ${gig.tourName ? `<p class="hint">${esc(gig.tourName)}</p>` : ""}
      ${note ? `<p>${esc(note)}</p>` : ""}
    </div>
  </article>`;
}

function codeTile(item) {
  const open = openCode === item.id;
  const picture = item.profileImage ? `<img alt="" src="${esc(item.profileImage)}">` : `<div class="fallback">${esc(item.orgName.slice(0, 1))}</div>`;
  const reveal = item.inPerson && item.qr
    ? `<span class="code-reveal"><span class="code-frame"><img alt="" src="${esc(item.qr)}"></span><small>${esc(item.label)}</small><strong>${esc(item.code)}</strong></span>`
    : `<span><small>${esc(item.label)}</small><strong>${esc(item.code)}</strong></span>`;
  return `<article class="tile code-tile${item.inPerson && item.qr ? " in-person" : ""}" data-code="${esc(item.id)}" role="button" tabindex="0" aria-expanded="${open}" aria-label="${esc(item.orgName)}">
    ${picture}
    <p class="tile-name">${esc(item.orgName)}</p>
    ${open ? reveal : ""}
    ${open ? `<button class="expand" type="button" data-expand="${esc(item.id)}" aria-label="Expand code">${expandIcon()}</button>` : ""}
  </article>`;
}

function codesPage() {
  if (!codes.length) return `<section class="page"><p class="empty">Priority codes from the people running an event show up here.</p></section>`;
  return `<section class="page"><div class="tiles">${codes.map(codeTile).join("")}</div></section>`;
}

function expiryLabel(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return `Expires ${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

function codeDetailPage() {
  const item = codes.find((code) => code.id === openCodePage);
  if (!item) return `<section class="event"><p class="empty">That code is not on your list.</p></section>`;
  return `<article class="event">
    <div class="code-hero">
      ${item.profileImage ? `<img alt="" src="${esc(item.profileImage)}">` : ""}
      <p class="tile-name">${esc(item.orgName)}</p>
    </div>
    <div class="stack">
      <h1>${esc(item.label)}</h1>
      ${item.message ? `<p>${esc(item.message)}</p>` : ""}
      ${item.expiresAt ? `<p class="hint">${esc(expiryLabel(item.expiresAt))}</p>` : ""}
      ${item.qr ? `<div class="qr-card"><img alt="${esc(item.label)}" src="${esc(item.qr)}"></div>` : ""}
      <p class="code-value">${esc(item.code)}</p>
    </div>
  </article>`;
}

function profileForm() {
  return `<main class="screen auth">${brand()}<form class="stack" id="profile">
    <h1>Profile</h1>
    <label>Username<input name="username" value="${esc(me?.username)}" required></label>
    <label>Email<input name="email" type="email" autocomplete="email" value="${esc(me?.email)}" required></label>
    <label>Phone<input name="phone" type="tel" autocomplete="tel" value="${esc(me?.phone)}" required></label>
    <label>City<input name="city" autocomplete="address-level2" value="${esc(me?.city)}"></label>
    <label>Country<input name="country" autocomplete="country-name" value="${esc(me?.country)}"></label>
    <label>Password<input name="currentPassword" type="password" autocomplete="current-password" required></label>
    ${!me?.city || !me?.country ? `<p class="hint">If you leave these blank, you will get codes for upcoming events in your city and country if you add those details.</p>` : ""}
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    ${notice ? `<p class="hint">${esc(notice)}</p>` : ""}
    <button class="primary" type="submit">Save</button>
    <button class="primary" type="button" id="open-password">Reset password</button>
    <button class="ghost" type="button" id="close-panel">Close</button>
  </form></main>`;
}

function passwordForm() {
  return `<main class="screen auth">${brand()}<form class="stack" id="password-form">
    <h1>Reset password</h1>
    <label>Old password<input name="currentPassword" type="password" autocomplete="current-password" required></label>
    <label>New password<input name="password" type="password" autocomplete="new-password" required></label>
    <label>New password again<input name="confirm" type="password" autocomplete="new-password" required></label>
    ${passwordRulesHtml()}
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <button class="primary" type="submit">Save password</button>
    <button class="ghost" type="button" id="back-profile">Back</button>
  </form></main>`;
}

function settingsForm() {
  return `<main class="screen auth">${brand()}<form class="stack" id="settings">
    <h1>Settings</h1>
    <label class="choice"><input id="dark-mode" name="darkMode" type="checkbox" ${darkMode ? "checked" : ""}> Dark mode</label>
    <label class="choice"><input name="registeredOnly" type="checkbox" ${me?.registeredOnly ? "checked" : ""}> Only get codes from people I have registered with</label>
    <label>Password<input name="currentPassword" type="password" autocomplete="current-password" required></label>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <button class="primary" type="submit">Save</button>
    <button class="ghost" type="button" id="close-panel">Close</button>
  </form></main>`;
}

function readCache() {
  try {
    const data = JSON.parse(localStorage.getItem(cacheKey) || "");
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache() {
  const snapshots = [
    { me, gigs, codes, savedAt: Date.now() },
    { me, gigs: gigs.map(({ image, ...rest }) => rest), codes, savedAt: Date.now() },
    { me, gigs: gigs.map(({ image, ...rest }) => rest), codes: codes.map(({ qr, profileImage, ...rest }) => rest), savedAt: Date.now() },
  ];
  for (const payload of snapshots) {
    try {
      localStorage.setItem(cacheKey, JSON.stringify(payload));
      return;
    } catch {
      /* try a smaller snapshot */
    }
  }
}

function hydrateCache() {
  const data = readCache();
  if (!data) return false;
  me = data.me || me;
  gigs = Array.isArray(data.gigs) ? data.gigs : gigs;
  codes = Array.isArray(data.codes) ? data.codes : codes;
  seenCodeIds = new Set(codes.map((item) => item.id));
  codesReady = codes.length > 0;
  return true;
}

function dropSession() {
  forgetSession();
  localStorage.removeItem(cacheKey);
  token = null;
  me = null;
  gigs = [];
  codes = [];
  codesReady = false;
  seenCodeIds = new Set();
  offline = false;
}

function transportError(cause) {
  return cause?.status === 0;
}

async function signOut() {
  clearInterval(codeTimer);
  await api("/api/logout", { method: "POST", token, body: {} }).catch(() => undefined);
  dropSession();
  authMode = "login";
  pendingEmail = "";
  sessionStorage.removeItem("ticketid.pending");
  panel = "";
  menuOpen = false;
  openCodePage = null;
  notice = "";
  render();
}

function bindShell() {
  document.querySelector("#login")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    error = "";
    const form = new FormData(event.currentTarget);
    try {
      const result = await api("/api/fan/login", { method: "POST", body: { email: form.get("email"), password: form.get("password") } });
      token = result.token;
      localStorage.setItem(tokenKey, token);
      localStorage.removeItem(cacheKey);
      me = null;
      gigs = [];
      codes = [];
      await load(true);
    } catch (cause) {
      error = cause.message;
      render();
    }
  });
  document.querySelector("#to-signup")?.addEventListener("click", () => { authMode = "signup"; error = ""; notice = ""; render(); });
  document.querySelector("#to-login")?.addEventListener("click", () => {
    leaveReset();
    authMode = "login";
    error = "";
    render();
  });
  document.querySelector("#forgot")?.addEventListener("click", () => { authMode = "recover"; error = ""; notice = ""; render(); });
  document.querySelector("#signup")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    error = "";
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    if (body.password !== body.confirm) {
      error = "Enter the same password twice.";
      render();
      return;
    }
    const problem = passwordProblem(body.password);
    if (problem) {
      error = problem;
      render();
      return;
    }
    try {
      const result = await api("/api/fan/signup", { method: "POST", body });
      token = result.token;
      localStorage.setItem(tokenKey, token);
      localStorage.removeItem(cacheKey);
      me = null;
      gigs = [];
      codes = [];
      pendingEmail = "";
      sessionStorage.removeItem("ticketid.pending");
      await load(true);
    } catch (cause) {
      error = cause.message;
      render();
    }
  });
  document.querySelector("#verify")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    error = "";
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/verify", { method: "POST", body: { actor: "fan", email: pendingEmail, code: form.get("code") } });
      pendingEmail = "";
      sessionStorage.removeItem("ticketid.pending");
      authMode = "login";
      render();
    } catch (cause) {
      error = cause.message;
      render();
    }
  });
  document.querySelector("#recover")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    error = "";
    const form = new FormData(event.currentTarget);
    recoverContact = String(form.get("contact") || "");
    try {
      await api("/api/fan/recover", { method: "POST", body: { contact: recoverContact } });
      recoverEmail = "";
      leaveReset();
      authMode = "login";
      notice = "If that account exists, we sent a link to the email on it. The link opens ticketID so you can choose a new password.";
      render();
    } catch (cause) {
      error = cause.message;
      render();
    }
  });
  document.querySelector("#link-reset")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    error = "";
    const form = new FormData(event.currentTarget);
    if (form.get("password") !== form.get("confirm")) {
      error = "Enter the same new password twice.";
      render();
      return;
    }
    const problem = passwordProblem(form.get("password"));
    if (problem) {
      error = problem;
      render();
      return;
    }
    try {
      await api("/api/fan/recover/confirm", {
        method: "POST",
        body: { oobCode: resetOob, password: form.get("password"), confirm: form.get("confirm") },
      });
      resetFinished = true;
      resetOob = "";
      dropSession();
      authMode = "login";
      notice = "Password updated. Log in with the new one.";
      error = "";
      history.replaceState(null, "", "/");
      render();
    } catch (cause) {
      error = cause.message;
      render();
    }
  });
  document.querySelector("#reset-again")?.addEventListener("click", () => {
    resetOob = "";
    authMode = "recover";
    error = "";
    history.replaceState(null, "", "/");
    render();
  });
  document.querySelector("#resend")?.addEventListener("click", async () => {
    error = "";
    try {
      await api("/api/resend", { method: "POST", body: { actor: "fan", email: pendingEmail } });
      error = "";
    } catch (cause) {
      error = cause.message;
    }
    render();
  });
  document.querySelectorAll(".code-tile").forEach((tile) => {
    tile.addEventListener("click", () => {
      if (tile.dataset.swipe === "1") {
        delete tile.dataset.swipe;
        return;
      }
      openCode = openCode === tile.dataset.code ? null : tile.dataset.code;
      render();
    });
  });
  document.querySelectorAll(".expand").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const tile = button.closest(".tile");
      if (button.dataset.swipe === "1" || tile?.dataset.swipe === "1") {
        delete button.dataset.swipe;
        if (tile) delete tile.dataset.swipe;
        return;
      }
      openCodePage = button.dataset.expand;
      openEvent = null;
      page = 2;
      render();
    });
  });
  document.querySelectorAll("[data-event]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.swipe === "1") {
        delete button.dataset.swipe;
        return;
      }
      openEvent = button.dataset.event;
      page = 1;
      render();
    });
  });
  document.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = Number(button.dataset.page);
      if (next === 2 && page !== 2) openCode = null;
      page = next;
      openEvent = null;
      openCodePage = null;
      render();
      if (next === 2) refreshCodes();
    });
  });
  document.querySelector("#generate")?.addEventListener("click", async (event) => {
    if (event.currentTarget.dataset.swipe === "1") {
      delete event.currentTarget.dataset.swipe;
      return;
    }
    error = "";
    try {
      live = await api("/api/fan/checkin", { method: "POST", token, body: {} });
      render();
      watch(live.id);
    } catch (cause) {
      if (cause?.status === 401) {
        dropSession();
        authMode = "login";
      } else {
        error = cause.message;
      }
      render();
    }
  });
  document.querySelector("#more")?.addEventListener("click", () => { menuOpen = !menuOpen; render(); });
  document.querySelector("#close-menu")?.addEventListener("click", () => { menuOpen = false; render(); });
  document.querySelectorAll("[data-menu]").forEach((button) => {
    button.addEventListener("click", () => {
      const choice = button.dataset.menu;
      menuOpen = false;
      error = "";
      notice = "";
      if (choice === "signout") {
        signOut();
        return;
      }
      panel = choice;
      render();
    });
  });
  watchPassword(document.querySelector("#signup"));
  watchPassword(document.querySelector("#link-reset"));
  watchPassword(document.querySelector("#password-form"));
  document.querySelector("#close-panel")?.addEventListener("click", () => { panel = ""; error = ""; notice = ""; render(); });
  document.querySelector("#open-password")?.addEventListener("click", () => { panel = "password"; error = ""; notice = ""; render(); });
  document.querySelector("#back-profile")?.addEventListener("click", () => { panel = "profile"; error = ""; render(); });
  document.querySelector("#dark-mode")?.addEventListener("change", (event) => {
    darkMode = event.currentTarget.checked;
    localStorage.setItem(themeKey, darkMode ? "dark" : "light");
    applyTheme();
  });
  document.querySelector("#profile")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      me = await api("/api/fan/me", {
        method: "PATCH",
        token,
        body: {
          username: form.get("username"),
          email: form.get("email"),
          phone: form.get("phone"),
          city: form.get("city"),
          country: form.get("country"),
          currentPassword: form.get("currentPassword"),
        },
      });
      writeCache();
      panel = "";
      error = "";
      notice = "";
      render();
    } catch (cause) {
      error = cause.message;
      render();
    }
  });
  document.querySelector("#settings")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      me = await api("/api/fan/me", {
        method: "PATCH",
        token,
        body: { registeredOnly: form.get("registeredOnly") === "on", currentPassword: form.get("currentPassword") },
      });
      writeCache();
      panel = "";
      error = "";
      notice = "";
      render();
    } catch (cause) {
      error = cause.message;
      render();
    }
  });
  document.querySelector("#password-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    error = "";
    const form = new FormData(event.currentTarget);
    if (form.get("password") !== form.get("confirm")) {
      error = "Enter the same new password twice.";
      render();
      return;
    }
    const problem = passwordProblem(form.get("password"));
    if (problem) {
      error = problem;
      render();
      return;
    }
    try {
      await api("/api/fan/password", {
        method: "POST",
        token,
        body: { currentPassword: form.get("currentPassword"), password: form.get("password"), confirm: form.get("confirm") },
      });
      panel = "profile";
      notice = "Password updated.";
      error = "";
      render();
    } catch (cause) {
      error = cause.message;
      render();
    }
  });
  const viewport = document.querySelector(".viewport");
  const pager = document.querySelector(".pager");
  const stage = document.querySelector(".stage");
  const pageWidth = () => stage?.clientWidth || viewport?.clientWidth || 1;
  const shiftFor = (index) => -(index * pageWidth());
  const placePager = (extra, animate) => {
    if (!pager) return;
    pager.style.transition = animate ? "transform 0.28s ease" : "none";
    pager.style.transform = `translateX(${shiftFor(page) + extra}px)`;
  };
  placePager(0, false);
  viewport?.addEventListener("pointerdown", (event) => {
    if (panel || menuOpen || confirmGig || openEvent || openCodePage) return;
    if (event.target.closest("input, textarea, a, .menu, .topbar, .menu-backdrop")) return;
    dragX = { x: event.clientX, y: event.clientY, id: event.pointerId, moved: false };
  });
  viewport?.addEventListener("pointermove", (event) => {
    if (!dragX || event.pointerId !== dragX.id || !pager) return;
    const dx = event.clientX - dragX.x;
    const dy = event.clientY - dragX.y;
    if (!dragX.moved) {
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        dragX = null;
        return;
      }
      dragX.moved = true;
      viewport.setPointerCapture?.(event.pointerId);
    }
    event.preventDefault();
    const width = pageWidth();
    const raw = shiftFor(page) + dx;
    const limited = Math.max(shiftFor(2), Math.min(shiftFor(0), raw));
    const eased = raw === limited ? limited : limited + (raw - limited) * 0.2;
    pager.style.transition = "none";
    pager.style.transform = `translateX(${eased}px)`;
    if (Math.abs(dx) > width * 0.08) event.target.closest(".tile, button")?.setAttribute("data-swipe", "1");
  }, { passive: false });
  viewport?.addEventListener("pointerup", (event) => {
    if (!dragX || event.pointerId !== dragX.id) return;
    const dx = event.clientX - dragX.x;
    const moved = dragX.moved;
    dragX = null;
    if (!moved) return;
    const before = page;
    const width = pageWidth();
    if (dx < -Math.min(72, width * 0.18) && page < 2) page += 1;
    if (dx > Math.min(72, width * 0.18) && page > 0) page -= 1;
    if (page === 2 && before !== 2) openCode = null;
    const tapped = event.target.closest(".tile, button");
    if (tapped) tapped.dataset.swipe = "1";
    placePager(0, true);
    if (page === before) return;
    openEvent = null;
    openCodePage = null;
    const settle = (transitionEvent) => {
      if (transitionEvent.propertyName !== "transform") return;
      pager.removeEventListener("transitionend", settle);
      render();
    };
    pager.addEventListener("transitionend", settle);
    if (page === 2) refreshCodes();
  });
  viewport?.addEventListener("pointercancel", () => {
    dragX = null;
    placePager(0, true);
  });
  viewport?.addEventListener("wheel", (event) => {
    if (panel || menuOpen || confirmGig || openEvent || openCodePage) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : 0;
    if (Math.abs(delta) < 30) return;
    const before = page;
    if (delta > 0 && page < 2) page += 1;
    if (delta < 0 && page > 0) page -= 1;
    if (page === 2 && before !== 2) openCode = null;
    if (page !== before) {
      event.preventDefault();
      openCodePage = null;
      render();
      if (page === 2) refreshCodes();
    }
  }, { passive: false });
}

async function watch(id) {
  const deadline = live?.expiresAt ? new Date(live.expiresAt).getTime() : Date.now() + 30_000;
  let stopped = false;
  let timer;
  let clock;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clearInterval(clock);
    clearTimeout(expireTimer);
  };
  const expireTimer = setTimeout(() => {
    if (!live || live.id !== id) return stop();
    stop();
    live = null;
    render();
  }, Math.max(0, deadline - Date.now()));
  clock = setInterval(paintCountdown, 200);
  paintCountdown();
  timer = setInterval(async () => {
    if (stopped || !live || live.id !== id) return stop();
    try {
      const status = await api(`/api/fan/checkin/${id}`, { token });
      if (status.status === "registered") {
        stop();
        live = null;
        confirmGig = status;
        await loadGigs();
        render();
        setTimeout(() => { confirmGig = null; render(); }, 4000);
        return;
      }
      if (stopped || !live || live.id !== id) return;
      if (status.status === "expired") {
        stop();
        live = null;
        render();
      }
    } catch {
      /* keep watching through a dropped packet */
    }
  }, 800);
}

async function loadGigs() {
  gigs = await api("/api/fan/gigs", { token });
  writeCache();
  keepMedia(gigs.map((gig) => gig.image)).catch(() => undefined);
}

async function loadCodes() {
  const next = await api("/api/fan/codes", { token });
  const arrived = codesReady ? next.filter((item) => !seenCodeIds.has(item.id)) : [];
  codes = next;
  seenCodeIds = new Set(next.map((item) => item.id));
  codesReady = true;
  writeCache();
  keepMedia(next.map((item) => item.profileImage)).catch(() => undefined);
  if (arrived.length && document.visibilityState === "visible") notifyCodes(arrived);
}

function refreshCodes() {
  if (!token) return;
  const before = codes.map((item) => item.id).join();
  loadCodes().then(() => {
    offline = false;
    const after = codes.map((item) => item.id).join();
    if ((after !== before || document.querySelector(".offline")) && page === 2 && token && !panel && !live) render();
  }).catch((cause) => {
    if (cause?.status === 401) {
      dropSession();
      authMode = "login";
      render();
      return;
    }
    if (transportError(cause)) {
      offline = true;
      if (page === 2 && !panel && !live) render();
      return;
    }
    error = cause.message;
    if (page === 2 && !panel && !live) render();
  });
}

function watchCodes() {
  clearInterval(codeTimer);
  if (!token) return;
  codeTimer = setInterval(() => {
    if (document.visibilityState === "visible" && token) refreshCodes();
  }, 5000);
}

function notifyCodes(items) {
  const local = window.Capacitor?.Plugins?.LocalNotifications;
  if (!local) return;
  local.schedule({
    notifications: items.map((item) => ({
      id: Math.floor(Math.random() * 1_000_000_000),
      title: item.orgName || "ticketID",
      body: item.label,
      channelId: "codes",
    })),
  }).catch(() => undefined);
}

function openCodes() {
  page = 2;
  panel = "";
  openEvent = null;
  openCode = null;
  openCodePage = null;
  if (token) render();
  refreshCodes();
}

async function registerPush() {
  const local = window.Capacitor?.Plugins?.LocalNotifications;
  const push = window.Capacitor?.Plugins?.PushNotifications;
  if (local?.createChannel) {
    await local.createChannel({ id: "codes", name: "Codes", importance: 5, visibility: 1 }).catch(() => undefined);
  }
  if (local && !pushReady) {
    const permission = await local.requestPermissions().catch(() => null);
    if (permission?.display === "granted") {
      await local.addListener("localNotificationActionPerformed", openCodes).catch(() => undefined);
    }
  }
  if (push && !pushReady) {
    await push.addListener("registration", (event) => {
      if (!token || !event?.value) return;
      api("/api/fan/device", { method: "POST", token, body: { token: event.value } }).catch(() => undefined);
    });
    await push.addListener("pushNotificationReceived", () => refreshCodes());
    await push.addListener("pushNotificationActionPerformed", openCodes);
  }
  pushReady = true;
  if (!push) return;
  const permission = await push.requestPermissions().catch(() => null);
  if (permission?.receive !== "granted") return;
  await push.register().catch(() => undefined);
}

async function load(reset = false) {
  try {
    me = await api("/api/fan/me", { token });
    await loadGigs();
    await loadCodes();
    offline = false;
    writeCache();
    keepMedia([
      ...gigs.map((gig) => gig.image),
      ...codes.map((item) => item.profileImage),
    ]).catch(() => undefined);
  } catch (cause) {
    if (cause?.status === 401) {
      dropSession();
      authMode = "login";
      throw cause;
    }
    if (!me) hydrateCache();
    else writeCache();
    offline = true;
  }
  if (reset) {
    page = 0;
    openCode = null;
    openCodePage = null;
  }
  render();
  watchCodes();
  registerPush().catch(() => undefined);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !token) return;
  if (openCode || openCodePage) {
    openCode = null;
    openCodePage = null;
    render();
  }
  refreshCodes();
});

const verifyToken = new URLSearchParams(location.search).get("token");
if (location.pathname === "/verify" && verifyToken) {
  render();
  api("/api/verify", { method: "POST", body: { token: verifyToken } }).then((result) => {
    location.href = result.actor === "org" ? "/dashboard/" : "/";
  }).catch((cause) => {
    error = cause.message;
    render();
  });
} else if (token) {
  if (hydrateCache()) render();
  load(true).catch(() => render());
} else {
  render();
}

window.addEventListener("online", () => {
  if (!token) return;
  load().catch(() => undefined);
});
window.addEventListener("offline", () => {
  if (!token) return;
  offline = true;
  render();
});
