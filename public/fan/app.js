const tokenKey = "ticketid.fan";

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
let live = null;
let confirmGig = null;
let authMode = "login";
let pendingEmail = sessionStorage.getItem("ticketid.pending") || "";
let recoverEmail = "";
let recoverContact = "";
let error = "";
let notice = "";
let dragX = null;
let openCode = null;
let openEvent = null;
let openCodePage = null;

const passwordRules = "Use at least 8 characters, with one capital letter, one number, and one special character.";

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Something went wrong.");
  return data;
}

function passwordProblem(password) {
  const value = String(password ?? "");
  if (value.length < 8 || !/[A-Z]/.test(value) || !/[0-9]/.test(value) || !/[^A-Za-z0-9]/.test(value)) return passwordRules;
  return "";
}

function expandIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H4v5M15 4h5v5M20 15v5h-5M4 15v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function dateLabel(iso) {
  const date = new Date(iso);
  const yearAgo = new Date();
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  if (date < yearAgo) return `${months[date.getMonth()]} ${date.getFullYear()}`;
  return `${date.getDate()} ${months[date.getMonth()]}`;
}

function wordmark() {
  return `<p class="wordmark">ticket<span>ID</span></p>`;
}

function brand(extra = "") {
  return `<header class="brand">${wordmark()}${extra}</header>`;
}

function render() {
  const params = new URLSearchParams(location.search);
  if (location.pathname === "/verify" || params.get("token")) {
    app.innerHTML = `<main class="screen auth">${brand()}<div class="stack"><p>Confirming your email.</p><p class="error">${esc(error)}</p></div></main>`;
    return;
  }
  if (!token) {
    const guest = pendingEmail ? verifyForm() : authMode === "signup" ? signupForm() : authMode === "recover" ? recoverForm() : authMode === "recover-password" ? recoverPasswordForm() : loginForm();
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
    ${menuOpen ? `<button class="menu-backdrop" id="close-menu" type="button" aria-label="Close menu"></button>` : ""}
    <div class="stage">
      ${openEvent ? eventPage() : openCodePage ? codeDetailPage() : `<div class="pager" style="transform: translateX(-${(2 - page) * 100}%)">
        ${codesPage()}
        ${gigsPage()}
        ${qrPage()}
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
    <p class="hint">${passwordRules}</p>
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
    <p>Enter the email or phone number on your account. We will send a code to the email on that account.</p>
    <label>Email or phone<input name="contact" autocomplete="username" required></label>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <button class="primary" type="submit">Send code</button>
    <button class="ghost" type="button" id="to-login">Back to log in</button>
  </form></main>`;
}

function recoverPasswordForm() {
  return `<main class="screen auth">${brand()}<form class="stack" id="recover-password">
    <h1>Reset password</h1>
    <p>We sent a code to ${esc(recoverEmail)}.</p>
    <label>Code<input name="code" autocomplete="one-time-code" required></label>
    <label>New password<input name="password" type="password" autocomplete="new-password" required></label>
    <label>New password again<input name="confirm" type="password" autocomplete="new-password" required></label>
    <p class="hint">${passwordRules}</p>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <button class="primary" type="submit">Save password</button>
    <button class="ghost" type="button" id="recover-resend">Send the code again</button>
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
    ? `<div class="qr-card"><img alt="One-time registration code" src="${live.qr}"><p>${esc(live.code)}</p></div>`
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

function eventWhen(iso) {
  const date = new Date(iso);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}, ${hours}:${minutes}`;
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
    <p class="hint">${passwordRules}</p>
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
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <button class="primary" type="submit">Save</button>
    <button class="ghost" type="button" id="close-panel">Close</button>
  </form></main>`;
}

async function signOut() {
  await api("/api/logout", { method: "POST", token, body: {} }).catch(() => undefined);
  localStorage.removeItem(tokenKey);
  token = null;
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
      await load();
    } catch (cause) {
      error = cause.message;
      if (cause.message.includes("Confirm your email")) {
        pendingEmail = String(form.get("email") || "");
        sessionStorage.setItem("ticketid.pending", pendingEmail);
      }
      render();
    }
  });
  document.querySelector("#to-signup")?.addEventListener("click", () => { authMode = "signup"; error = ""; notice = ""; render(); });
  document.querySelector("#to-login")?.addEventListener("click", () => { authMode = "login"; error = ""; render(); });
  document.querySelector("#forgot")?.addEventListener("click", () => { authMode = "recover"; error = ""; notice = ""; render(); });
  document.querySelector("#signup")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    error = "";
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    const problem = passwordProblem(body.password);
    if (problem) {
      error = problem;
      render();
      return;
    }
    try {
      await api("/api/fan/signup", { method: "POST", body });
      pendingEmail = body.email;
      sessionStorage.setItem("ticketid.pending", pendingEmail);
      render();
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
      const result = await api("/api/fan/recover", { method: "POST", body: { contact: recoverContact } });
      recoverEmail = result.email;
      authMode = "recover-password";
      render();
    } catch (cause) {
      error = cause.message;
      render();
    }
  });
  document.querySelector("#recover-password")?.addEventListener("submit", async (event) => {
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
        body: { email: recoverEmail, code: form.get("code"), password: form.get("password"), confirm: form.get("confirm") },
      });
      authMode = "login";
      notice = "Password updated. Log in with the new one.";
      error = "";
      render();
    } catch (cause) {
      error = cause.message;
      render();
    }
  });
  document.querySelector("#recover-resend")?.addEventListener("click", async () => {
    error = "";
    try {
      const result = await api("/api/fan/recover", { method: "POST", body: { contact: recoverContact } });
      recoverEmail = result.email;
      notice = "";
      error = "";
    } catch (cause) {
      error = cause.message;
    }
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
      error = cause.message;
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
        },
      });
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
        body: { registeredOnly: form.get("registeredOnly") === "on" },
      });
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
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        dragX = null;
        return;
      }
      dragX.moved = true;
      viewport.setPointerCapture(event.pointerId);
    }
    pager.style.transition = "none";
    pager.style.transform = `translateX(${-(2 - page) * pager.clientWidth + dx}px)`;
  });
  viewport?.addEventListener("pointerup", (event) => {
    if (!dragX || event.pointerId !== dragX.id) return;
    const dx = event.clientX - dragX.x;
    const moved = dragX.moved;
    dragX = null;
    if (!moved) return;
    const before = page;
    if (dx > 40 && page < 2) page += 1;
    if (dx < -40 && page > 0) page -= 1;
    if (page === 2 && before !== 2) openCode = null;
    const tapped = event.target.closest(".tile") || event.target.closest("button");
    if (tapped) tapped.dataset.swipe = "1";
    if (page === before) {
      if (pager) {
        pager.style.transition = "";
        pager.style.transform = `translateX(-${(2 - page) * 100}%)`;
      }
      return;
    }
    openCodePage = null;
    render();
  });
  viewport?.addEventListener("pointercancel", () => { dragX = null; });
  viewport?.addEventListener("wheel", (event) => {
    if (panel || menuOpen || confirmGig || openEvent || openCodePage) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : 0;
    if (Math.abs(delta) < 30) return;
    const before = page;
    if (delta < 0 && page < 2) page += 1;
    if (delta > 0 && page > 0) page -= 1;
    if (page === 2 && before !== 2) openCode = null;
    if (page !== before) {
      event.preventDefault();
      openCodePage = null;
      render();
    }
  }, { passive: false });
}

async function watch(id) {
  const deadline = live?.expiresAt ? new Date(live.expiresAt).getTime() : Date.now() + 10_000;
  let stopped = false;
  let timer;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clearTimeout(expireTimer);
  };
  const expireTimer = setTimeout(() => {
    if (!live || live.id !== id) return stop();
    stop();
    live = null;
    render();
  }, Math.max(0, deadline - Date.now()));
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
      stop();
    }
  }, 800);
}

async function loadGigs() {
  gigs = await api("/api/fan/gigs", { token });
}

async function loadCodes() {
  codes = await api("/api/fan/codes", { token });
}

async function load() {
  me = await api("/api/fan/me", { token });
  await loadGigs();
  await loadCodes();
  page = 0;
  openCode = null;
  openCodePage = null;
  render();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !token) return;
  if (!openCode && !openCodePage) return;
  openCode = null;
  openCodePage = null;
  render();
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
  load().catch(() => {
    localStorage.removeItem(tokenKey);
    token = null;
    render();
  });
} else {
  render();
}
