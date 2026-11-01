import { api, resolve } from "/net.js";
import { gigDay, isWallClock, wallHasPassed } from "/when.js";

window.TICKETID_ACTOR = "org";
const tokenKey = "ticketid.org";
const app = document.querySelector("#app");
const everyoneLabel = "Everyone who has registered with you";
let token = localStorage.getItem(tokenKey);
let me = null;
let gigs = [];
let issued = [];
let page = "event";
let view = "login";
let gig = null;
let joinCode = "";
let joinExpires = 0;
let joinTimer = 0;
let scanner = null;
let scanners = [];
let error = "";
let notice = "";
let pendingEmail = sessionStorage.getItem("ticketid.org.pending") || "";
let showPast = false;
let confirmAction = "";
let draft = blankDraft();
let sendForm = blankSend();
let profileDraft = null;
let audiencePlaces = { cities: [], countries: [] };
const heldFiles = { image: "", picture: "" };
let holdGeneration = 0;
let routeGeneration = 0;
let countGeneration = 0;

const kinds = [
  ["band", "Band"],
  ["team", "Sports team"],
  ["ensemble", "Ensemble"],
  ["organiser", "Organiser"],
  ["venue", "Venue"],
  ["festival", "Festival"],
];

function blankDraft() {
  return { name: "", date: "", time: "", bio: "", city: "", country: "", tourPick: "", tourName: "", copyFrom: "", copyLabel: "" };
}

function blankSend() {
  return {
    step: 1,
    label: "",
    message: "",
    inPerson: false,
    expires: "",
    type: "events",
    gigIds: [],
    tours: [],
    placeKind: "city",
    names: [],
    extra: [],
    menuOpen: false,
    count: null,
    counting: false,
  };
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

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

function passwordProblem(password) {
  const value = String(password ?? "");
  if (value.length < 8 || !/[A-Z]/.test(value) || !/[0-9]/.test(value) || !/[^A-Za-z0-9]/.test(value)) {
    return "Use at least 8 characters, with one capital letter, one number, and one special character.";
  }
  return "";
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("That image could not be read."));
    image.src = url;
  });
}

async function shrinkImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    const longest = Math.max(image.width, image.height) || 1;
    const scale = Math.min(1, 1400 / longest);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    let quality = 0.86;
    let dataUrl = canvas.toDataURL("image/jpeg", quality);
    while (dataUrl.length > 1_800_000 && quality > 0.5) {
      quality -= 0.12;
      dataUrl = canvas.toDataURL("image/jpeg", quality);
    }
    return dataUrl;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function readImage(file) {
  if (!file) return "";
  let last = new Error("That image could not be read.");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const blob = file.slice(0, file.size > 0 ? file.size : undefined, file.type || "image/jpeg");
      const buffer = await blob.arrayBuffer();
      if (!buffer.byteLength) throw new Error("That image could not be read.");
      return await shrinkImage(new Blob([buffer], { type: file.type || "image/jpeg" }));
    } catch (cause) {
      last = cause instanceof Error ? cause : last;
      await pause(70 * 2 ** attempt);
    }
  }
  throw last;
}

async function holdFile(input) {
  const generation = ++holdGeneration;
  const key = input.name === "picture" ? "picture" : "image";
  const file = input.files && input.files[0];
  if (!file) {
    heldFiles[key] = "";
    return;
  }
  try {
    const data = await readImage(file);
    if (generation !== holdGeneration) return;
    heldFiles[key] = data;
    error = "";
  } catch (cause) {
    if (generation !== holdGeneration) return;
    heldFiles[key] = "";
    error = cause.message;
  }
  render();
}

function chosenImage(name, file) {
  if (heldFiles[name]) return Promise.resolve(heldFiles[name]);
  return readImage(file);
}

function tours() {
  return [...new Set(gigs.map((item) => item.tourName).filter(Boolean))].sort();
}

function places(kind) {
  const extra = kind === "country" ? audiencePlaces.countries : audiencePlaces.cities;
  const key = kind === "country" ? "country" : "city";
  return [...new Set([...gigs.map((item) => item[key]).filter(Boolean), ...extra])].sort();
}

function signedInLabel(iso) {
  const date = new Date(iso);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${when(iso)}, ${hours}:${minutes}`;
}

function when(iso) {
  if (!iso) return "Date not set";
  if (isWallClock(iso)) return gigDay(iso);
  const date = new Date(iso);
  return `${date.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()]} ${date.getFullYear()}`;
}

function eventChoiceLabel(item) {
  const name = item.name || "Untitled event";
  const shared = gigs.filter((gigItem) => (gigItem.name || "Untitled event") === name).length > 1;
  return shared ? `${name}, ${when(item.startsAt)}` : name;
}

function completed(item) {
  return wallHasPassed(item.startsAt);
}

function canDelete(item) {
  return !item?.startsAt || !item.live;
}

function peopleLabel(count) {
  const total = Number(count) || 0;
  return total === 1 ? "1 person" : `${total} people`;
}

function registeredLabel(count) {
  const total = Number(count) || 0;
  return total === 1 ? "1 person registered" : `${total} people registered`;
}

function scannerLabel(count) {
  const total = Number(count) || 0;
  return total === 1 ? "1 scanner signed in" : `${total} scanners signed in`;
}

function roleTitle(role) {
  if (role === "act") return "Bands";
  if (role === "venue") return "Venue";
  return role === "festival" ? "Festival" : "Organiser";
}

function upcomingId() {
  const next = gigs
    .filter((item) => item.startsAt && !completed(item))
    .sort((left, right) => String(left.startsAt).localeCompare(String(right.startsAt)))[0];
  return next?.id || "";
}

function readRoute() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [name, id] = raw.split("/");
  if (name === "event") return { page: "event", id: id || "" };
  if (["events", "create", "send", "issued", "profile"].includes(name)) return { page: name, id: "" };
  return { page: "event", id: "" };
}

function writeRoute() {
  const next = page === "event" ? (gig?.id ? `#/event/${gig.id}` : "#/event") : `#/${page}`;
  const url = `${location.pathname}${location.search}${next}`;
  if (`${location.pathname}${location.search}${location.hash}` !== url) history.replaceState(null, "", url);
}

function resetPageDraft(next) {
  holdGeneration += 1;
  if (next === "create") {
    draft = blankDraft();
    heldFiles.image = "";
  }
  if (next === "send") {
    sendForm = blankSend();
    heldFiles.image = "";
  }
  if (next === "profile") {
    heldFiles.picture = "";
    profileDraft = null;
  }
}

function startJoinClock() {
  clearInterval(joinTimer);
  joinTimer = setInterval(() => {
    const seconds = Math.max(0, Math.ceil((joinExpires - Date.now()) / 1000));
    if (seconds <= 0) {
      joinCode = "";
      clearInterval(joinTimer);
      if (page === "profile") render();
      return;
    }
    const node = document.querySelector("#join-left");
    if (node) node.textContent = `${seconds}s`;
  }, 1000);
}

function joinSeconds() {
  if (!joinCode) return 0;
  const seconds = Math.max(0, Math.ceil((joinExpires - Date.now()) / 1000));
  if (!seconds) joinCode = "";
  return seconds;
}

function currentAudience() {
  if (sendForm.type === "all") return { type: "all", label: everyoneLabel };
  if (sendForm.type === "events" && sendForm.gigIds.length) {
    const names = gigs.filter((item) => sendForm.gigIds.includes(item.id)).map((item) => eventChoiceLabel(item));
    return { type: "events", gigIds: [...sendForm.gigIds], label: `Events: ${names.join(" · ")}` };
  }
  if (sendForm.type === "tours" && sendForm.tours.length) {
    return { type: "tours", tours: [...sendForm.tours], label: `Tours: ${sendForm.tours.join(", ")}` };
  }
  if (sendForm.type === "places" && sendForm.names.length) {
    const kind = sendForm.placeKind === "country" ? "Countries" : "Cities";
    return { type: "places", names: [...sendForm.names], label: `${kind}: ${sendForm.names.join(", ")}` };
  }
  return null;
}

function audienceGroups() {
  const current = currentAudience();
  return current ? [...sendForm.extra, current] : [...sendForm.extra];
}

function payloadGroups() {
  return audienceGroups().map(({ type, gigIds, tours, names, label }) => ({ type, gigIds, tours, names, label }));
}

function countState() {
  if (!audienceGroups().length) return { text: "Choose who should receive this code.", ready: false };
  if (sendForm.counting || sendForm.count === null) return { text: "Counting…", ready: false };
  if (!sendForm.count) return { text: "Nobody in that group can receive a code yet.", ready: false };
  return { text: peopleLabel(sendForm.count), ready: true };
}

function paintCount() {
  const state = countState();
  const node = document.querySelector("#who-count");
  if (node) {
    node.textContent = state.text;
    node.className = state.ready ? "tally" : "hint";
  }
  const button = document.querySelector("#continue-send");
  if (button) button.disabled = !state.ready;
  const add = document.querySelector("#add-audience");
  if (add) add.hidden = !currentAudience();
}

async function refreshCount() {
  const groups = payloadGroups();
  const generation = ++countGeneration;
  if (!groups.length) {
    sendForm.count = null;
    sendForm.counting = false;
    paintCount();
    return;
  }
  sendForm.count = null;
  sendForm.counting = true;
  paintCount();
  try {
    const result = await api("/api/codes/preview", { method: "POST", token, body: { groups } });
    if (generation !== countGeneration) return;
    sendForm.count = result.count;
    sendForm.counting = false;
    error = "";
    paintCount();
  } catch (cause) {
    if (generation !== countGeneration) return;
    sendForm.count = null;
    sendForm.counting = false;
    error = cause.message;
    render();
  }
}

function draftPreview() {
  if (heldFiles.image) return heldFiles.image;
  if (!draft.copyFrom) return "";
  return gigs.find((item) => item.id === draft.copyFrom)?.image || "";
}

function pageTitle() {
  if (page === "event") return gig ? (gig.name || "Untitled event") : "Event";
  if (page === "events") return "Events";
  if (page === "create") return "Create event";
  if (page === "send") return "Send codes";
  if (page === "issued") return "Issued codes";
  return "Profile";
}

function render() {
  if (!token) {
    app.innerHTML = pendingEmail ? verifyView() : view === "signup" ? signupView() : loginView();
    bindAuth();
    return;
  }
  const body = page === "create" ? createView()
    : page === "events" ? eventsView()
    : page === "event" ? eventView()
    : page === "send" ? sendView()
    : page === "issued" ? issuedView()
    : profileView();
  app.innerHTML = frame(pageTitle(), body);
  bindApp();
  if (page === "send" && sendForm.step === 1) paintCount();
}

function frame(title, body) {
  return `<div class="shell">
    <header class="phone-bar">
      <p class="wordmark">ticket<span>ID</span></p>
      <button class="ghost" type="button" data-signout>Sign out</button>
    </header>
    <aside class="side">
      <div class="lockup"><p class="wordmark">ticket<span>ID</span></p><p class="role">Dashboard</p></div>
      ${nav()}
      <button class="ghost" type="button" data-signout>Sign out</button>
    </aside>
    <main class="work stack">
      <h1>${esc(title)}</h1>
      ${error ? `<p class="error">${esc(error)}</p>` : ""}
      ${notice ? `<p class="hint">${esc(notice)}</p>` : ""}
      ${body}
    </main>
    ${phoneNav()}
  </div>`;
}

function nav() {
  const items = [["event", "Event"], ["events", "Events"], ["create", "Create event"], ["send", "Send codes"], ["issued", "Issued codes"], ["profile", "Profile"]];
  return `<nav class="nav">${items.map(([id, label]) => `<button type="button" data-page="${id}" ${page === id ? "aria-current=\"page\"" : ""}>${label}</button>`).join("")}</nav>`;
}

function phoneNav() {
  const items = [["event", "Event"], ["events", "Events"], ["create", "Create"], ["send", "Send"], ["issued", "Issued"], ["profile", "Profile"]];
  return `<nav class="phone-nav">${items.map(([id, label]) => `<button type="button" data-page="${id}" ${page === id ? "aria-current=\"page\"" : ""}>${label}</button>`).join("")}</nav>`;
}

function loginView() {
  return `<main class="auth-wrap stack"><div class="lockup"><p class="wordmark">ticket<span>ID</span></p><p class="role">Dashboard</p></div><form class="stack" id="login">
    <label>Email<input name="email" type="email" autocomplete="username" required></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    ${notice ? `<p class="hint">${esc(notice)}</p>` : ""}
    <button class="primary" type="submit">Log in</button>
    <button class="ghost" id="to-signup" type="button">Create an account</button>
  </form></main>`;
}

function signupView() {
  return `<main class="auth-wrap stack"><div class="lockup"><p class="wordmark">ticket<span>ID</span></p><p class="role">Dashboard</p></div><form class="stack" id="signup">
    <label>Account<select name="kind">${kinds.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>
    <label>Name<input name="name" required></label>
    <label>Email<input name="email" type="email" required></label>
    <label>Password<input name="password" type="password" autocomplete="new-password" required></label>
    <label>Password again<input name="confirm" type="password" autocomplete="new-password" required></label>
    ${passwordRulesHtml()}
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <button class="primary" type="submit">Create account</button>
    <button class="ghost" id="to-login" type="button">I already have an account</button>
  </form></main>`;
}

function verifyView() {
  return `<main class="auth-wrap stack"><div class="lockup"><p class="wordmark">ticket<span>ID</span></p><p class="role">Dashboard</p></div><form class="stack" id="verify">
    <p>We sent a message to ${esc(pendingEmail)}. Open the link, or enter the code. The account stays closed until that is done.</p>
    <label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code" required></label>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <button class="primary" type="submit">Confirm email</button>
    <button class="ghost" id="resend" type="button">Send the email again</button>
    <button class="ghost" id="to-login" type="button">Back to log in</button>
  </form></main>`;
}

function createView() {
  const previous = gigs.filter((item) => item.name);
  const preview = draftPreview();
  return `<form class="stack" id="create-event">
    <label>Copy previous event<select name="copyFrom">
      <option value="">Start a blank event</option>
      ${previous.map((item) => `<option value="${esc(item.id)}" ${draft.copyFrom === item.id ? "selected" : ""}>${esc(item.name)}</option>`).join("")}
    </select></label>
    ${draft.copyLabel ? `<p class="hint">Using the picture from ${esc(draft.copyLabel)} unless you choose a new one. Date and start time are left blank.</p>` : ""}
    <label>Name<input name="name" value="${esc(draft.name)}" required></label>
    <div class="split">
      <label>Date<input name="date" type="date" value="${esc(draft.date)}" required></label>
      <label>Time<input name="time" type="time" value="${esc(draft.time)}" required></label>
    </div>
    <label>Bio<textarea name="bio">${esc(draft.bio)}</textarea></label>
    <label>Picture<input name="image" type="file" accept="image/png,image/jpeg,image/webp" ${draft.copyFrom || heldFiles.image ? "" : "required"}></label>
    <p class="hint">Fans see this when they register, and the scanner shows it on the night.</p>
    ${preview ? `<img class="cover" alt="" src="${esc(preview)}">` : ""}
    <div class="split">
      <label>City<input name="city" value="${esc(draft.city)}"></label>
      <label>Country<input name="country" value="${esc(draft.country)}"></label>
    </div>
    <p class="hint">City and country are how a later code finds people in that place.</p>
    <label>Tour or series<select name="tourPick">
      <option value="" ${draft.tourPick === "" ? "selected" : ""}>No tour</option>
      <option value="__new" ${draft.tourPick === "__new" ? "selected" : ""}>Create new</option>
      ${tours().map((name) => `<option value="${esc(name)}" ${draft.tourPick === name ? "selected" : ""}>${esc(name)}</option>`).join("")}
    </select></label>
    ${draft.tourPick === "__new" ? `<label>New tour or series<input name="tourName" value="${esc(draft.tourName)}"></label>` : ""}
    <button class="primary" type="submit">Create event</button>
  </form>`;
}

function eventsView() {
  const shown = gigs.filter((item) => showPast || !completed(item)).sort(compareEvents);
  return `<label class="choice"><input id="show-past" type="checkbox" ${showPast ? "checked" : ""}> Show past events</label>
    <div class="event-grid">${shown.map((item) => `<button class="event-tile" type="button" data-gig="${esc(item.id)}">
      ${item.image ? `<img alt="" src="${esc(item.image)}">` : `<span class="event-fallback"></span>`}
      <strong>${esc(item.name || "Untitled event")}</strong>
      <small>${esc(when(item.startsAt))} · ${item.live ? "Live" : "Not live"}</small>
      <small>${esc(registeredLabel(item.registered))}</small>
    </button>`).join("") || `<p class="hint">No events to show.</p>`}</div>`;
}

function compareEvents(left, right) {
  const leftDone = completed(left);
  const rightDone = completed(right);
  if (leftDone !== rightDone) return leftDone ? 1 : -1;
  if (!left.startsAt && !right.startsAt) return 0;
  if (!left.startsAt) return 1;
  if (!right.startsAt) return -1;
  const order = String(left.startsAt).localeCompare(String(right.startsAt));
  return leftDone ? -order : order;
}

function eventView() {
  if (!gig) {
    return `<p class="hint">No upcoming event. Past events are in the list.</p>
      <button class="primary" id="go-create" type="button">Create event</button>`;
  }
  const place = [gig.city, gig.country].filter(Boolean).join(", ");
  const parts = [gig.live ? "Live" : "Not live", registeredLabel(gig.registered)];
  if (gig.owner) parts.push(scannerLabel(scanners.length));
  return `<p class="status">${esc(parts.join(" · "))}</p>
    ${gig.image ? `<img class="cover" alt="" src="${esc(gig.image)}">` : ""}
    <p>${esc(when(gig.startsAt))}${place ? ` · ${esc(place)}` : ""}</p>
    ${gig.bio ? `<p>${esc(gig.bio)}</p>` : ""}
    ${gig.tourName ? `<p class="hint">${esc(gig.tourName)}</p>` : ""}
    ${billBlock()}
    ${gig.owner ? `<section class="panel"><h2>Check-in</h2>${checkinBlock()}</section>${deleteBlock()}` : `<section class="panel"><p>You can send a code to people who registered at this event.</p><button class="primary" id="send-to-event" type="button">Send a code</button></section>`}`;
}

function billBlock() {
  const members = gig.members || [];
  const roles = ["act", "venue", "festival", "organiser"].filter((role) => members.some((member) => member.role === role));
  return `<section class="panel">
    <h2>On the bill</h2>
    ${roles.map((role) => `<div><h2>${roleTitle(role)}</h2><p class="members">${members.filter((member) => member.role === role).map((member) => esc(member.name)).join("<br>")}</p></div>`).join("")}
    ${gig.owner ? `<form class="stack" id="add-member">
      <label>Event code<input name="code" autocapitalize="characters" autocomplete="off" required></label>
      <p class="hint">The event code from their Profile. It adds them to this bill.</p>
      <button class="secondary" type="submit">Add</button>
    </form>` : ""}
  </section>`;
}

function checkinBlock() {
  if (!gig.live) {
    if (!gig.ready) return `<p class="hint">Add a name, date, and picture before this event can go live.</p>`;
    return `<button class="primary" id="go-live" type="button">Go live</button>`;
  }
  return `<button class="primary" id="scanner-code" type="button">Generate scanner code</button>
    ${scanner?.gigId === gig.id ? `<p class="join-code">${esc(scanner.code)}</p>
      ${scanner.qr ? `<img class="door-qr" alt="Scanner code" src="${esc(scanner.qr)}">` : ""}
      <p class="hint">This code works once, for one new phone, and lasts 24 hours. Ending check-in destroys it.</p>` : `<p class="hint">A scanner code is created when you ask for one. It lasts 24 hours, or until you end check-in.</p>`}
    <h2>Signed-in scanners</h2>
    ${scanners.length ? scanners.map((item) => `<div class="scanner-row"><span>Signed in ${esc(signedInLabel(item.signedInAt))}</span><button class="ghost" type="button" data-receiver="${esc(item.id)}">Disconnect</button></div>`).join("") : `<p class="hint">No scanners are signed in.</p>`}
    <p class="hint">A scanner stays signed in for 24 hours. End check-in to sign every scanner out at once.</p>
    ${confirmAction === "end" ? `<div class="confirm"><p>End check-in? Every scanner will be signed out, and unused scanner codes will stop working.</p><div class="actions"><button class="danger" id="end-live" type="button">End check-in</button><button class="ghost" id="cancel-confirm" type="button">Cancel</button></div></div>` : `<button class="danger" id="ask-end" type="button">End check-in</button>`}`;
}

function deleteBlock() {
  if (!canDelete(gig)) return "";
  if (confirmAction === "delete") {
    return `<section class="panel"><div class="confirm"><p>Delete this event?</p><div class="actions"><button class="danger" id="delete-event" type="button">Delete event</button><button class="ghost" id="cancel-confirm" type="button">Cancel</button></div></div></section>`;
  }
  return `<section class="panel"><button class="danger" id="ask-delete" type="button">Delete event</button></section>`;
}

function sendView() {
  if (sendForm.step === 2) return sendCodeView();
  const choices = sendForm.type === "tours" ? tours() : sendForm.type === "places" ? places(sendForm.placeKind) : gigs.filter((item) => item.name);
  const selected = sendForm.type === "tours" ? sendForm.tours : sendForm.type === "places" ? sendForm.names : sendForm.gigIds;
  const state = countState();
  return `<form class="stack" id="who-form">
    <h2>Who receives it</h2>
    <label>Audience<select name="type">
      <option value="events" ${sendForm.type === "events" ? "selected" : ""}>Attendees of specific events</option>
      <option value="tours" ${sendForm.type === "tours" ? "selected" : ""}>Attendees of a tour or series</option>
      <option value="places" ${sendForm.type === "places" ? "selected" : ""}>Fans from cities or countries</option>
      <option value="all" ${sendForm.type === "all" ? "selected" : ""}>${everyoneLabel}</option>
    </select></label>
    ${sendForm.type === "places" ? `<p class="hint">A city or country includes people who registered at your event there, and people who registered with you and live there. Each person gets one code.</p><label>Cities or countries<select name="placeKind">
      <option value="city" ${sendForm.placeKind === "city" ? "selected" : ""}>Cities</option>
      <option value="country" ${sendForm.placeKind === "country" ? "selected" : ""}>Countries</option>
    </select></label>` : ""}
    ${sendForm.type === "all" ? "" : `<details class="drop" ${sendForm.menuOpen ? "open" : ""}>
      <summary id="pick-summary">${selected.length ? `${selected.length} selected` : "Choose"}</summary>
      <div class="drop-list">
        <button class="ghost sticky" id="select-all" type="button">Select all</button>
        ${choices.map((item) => {
          const id = sendForm.type === "events" ? item.id : item;
          const label = sendForm.type === "events" ? eventChoiceLabel(item) : item;
          return `<label class="choice"><input type="checkbox" data-pick="${esc(id)}" ${selected.includes(id) ? "checked" : ""}> ${esc(label)}</label>`;
        }).join("") || `<p class="hint">Nothing to choose yet.</p>`}
      </div>
    </details>`}
    ${sendForm.extra.length ? `<ul class="groups">${sendForm.extra.map((group) => `<li><span>${esc(group.label)}</span><button type="button" data-remove="${esc(group.id)}" aria-label="Remove audience">×</button></li>`).join("")}</ul>` : ""}
    <button class="secondary" id="add-audience" type="button" ${currentAudience() ? "" : "hidden"}>Add another audience</button>
    <p id="who-count" class="${state.ready ? "tally" : "hint"}">${esc(state.text)}</p>
    <button class="primary" id="continue-send" type="button" ${state.ready ? "" : "disabled"}>Continue</button>
  </form>`;
}

function sendCodeView() {
  const preview = heldFiles.image;
  return `<form class="stack" id="send-form">
    <h2>The code</h2>
    <button class="ghost" id="send-back" type="button">Back</button>
    <p class="hint">${esc(audienceGroups().map((group) => group.label).join(" · "))}</p>
    <p class="tally">${esc(peopleLabel(sendForm.count || 0))}</p>
    <label>Name<input name="label" value="${esc(sendForm.label)}" placeholder="2027 World Tour" required></label>
    <label>Message<textarea name="message" required>${esc(sendForm.message)}</textarea></label>
    <fieldset class="choice-set"><legend>Code</legend>
      <label class="choice"><input name="format" type="radio" value="text" ${sendForm.inPerson ? "" : "checked"}> Text</label>
      <label class="choice"><input name="format" type="radio" value="qr" ${sendForm.inPerson ? "checked" : ""}> QR code</label>
    </fieldset>
    <label>Tile picture<input name="image" type="file" accept="image/png,image/jpeg,image/webp" ${preview ? "" : "required"}></label>
    ${preview ? `<img class="cover" alt="" src="${esc(preview)}">` : ""}
    <label>Expiry<input name="expires" type="date" value="${esc(sendForm.expires)}" required></label>
    <button class="primary" type="submit">Send codes</button>
  </form>`;
}

function issuedMeta(item) {
  const parts = [];
  if (item.groups?.length) parts.push(item.groups.join(" · "));
  parts.push(item.inPerson ? "QR code" : "Text");
  parts.push(item.expiresAt ? `Expires ${when(item.expiresAt)}` : "No expiry");
  return parts.join(" · ");
}

function issuedView() {
  if (!issued.length) return `<p class="hint">Codes you send will be listed here.</p>`;
  return `<ul class="issued">${issued.map((item) => `<li>
    ${item.image ? `<img alt="" src="${esc(item.image)}">` : ""}
    <div class="issued-main">
      <strong>${esc(item.label)}</strong>
      <p class="issued-count">${esc(peopleLabel(item.count))}</p>
      ${item.message ? `<p class="hint">${esc(item.message)}</p>` : ""}
      <p class="hint">${esc(issuedMeta(item))}</p>
      ${item.filename ? `<button class="ghost" type="button" data-csv="${esc(item.id)}" data-filename="${esc(item.filename)}">Download</button>` : ""}
    </div>
  </li>`).join("")}</ul>`;
}

function profileView() {
  const seconds = joinSeconds();
  const name = profileDraft?.name ?? me?.name ?? "";
  const kind = profileDraft?.kind ?? me?.kind ?? "band";
  const picture = heldFiles.picture || me?.profileImage || "";
  return `<section class="panel">
    <h2>Event code</h2>
    <p class="hint">This is the code another organisation types to add you to their bill.</p>
    <button class="primary" id="new-code" type="button">Generate event code</button>
    ${joinCode ? `<p class="join-code">${esc(joinCode)}</p><p class="hint" id="join-left">${seconds}s</p>` : ""}
  </section>
  <section class="panel"><form class="stack" id="profile">
    <h2>Account</h2>
    ${picture ? `<img class="profile-pic" alt="" src="${esc(picture)}">` : ""}
    <label>Name<input name="name" value="${esc(name)}" required></label>
    <label>You are a<select name="kind">${kinds.map(([value, label]) => `<option value="${value}" ${kind === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
    <label>Profile picture<input name="picture" type="file" accept="image/png,image/jpeg,image/webp"></label>
    <button class="primary" type="submit">Save profile</button>
  </form></section>`;
}

function bindAuth() {
  document.querySelector("#to-signup")?.addEventListener("click", () => { view = "signup"; error = ""; notice = ""; render(); });
  document.querySelector("#to-login")?.addEventListener("click", () => {
    view = "login";
    pendingEmail = "";
    sessionStorage.removeItem("ticketid.org.pending");
    error = "";
    render();
  });
  document.querySelector("#login")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await api("/api/org/login", { method: "POST", body: { email: form.get("email"), password: form.get("password") } });
      if (result.needsVerify) {
        pendingEmail = result.email;
        sessionStorage.setItem("ticketid.org.pending", pendingEmail);
        error = "";
        render();
        return;
      }
      if (!result.token) throw new Error("Sign in to continue.");
      token = result.token;
      localStorage.setItem(tokenKey, token);
      error = "";
      await load();
    } catch (cause) {
      error = cause.message;
      render();
    }
  });
  document.querySelector("#signup")?.addEventListener("submit", async (event) => {
    event.preventDefault();
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
      const result = await api("/api/org/signup", { method: "POST", body });
      if (result.needsVerify) {
        pendingEmail = result.email;
        sessionStorage.setItem("ticketid.org.pending", pendingEmail);
        error = "";
        render();
        return;
      }
      if (!result.token) throw new Error("Sign in to continue.");
      token = result.token;
      localStorage.setItem(tokenKey, token);
      pendingEmail = "";
      sessionStorage.removeItem("ticketid.org.pending");
      error = "";
      await load();
    } catch (cause) {
      error = cause.message;
      render();
    }
  });
  document.querySelector("#verify")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/verify", { method: "POST", body: { actor: "org", email: pendingEmail, code: form.get("code") } });
      pendingEmail = "";
      sessionStorage.removeItem("ticketid.org.pending");
      view = "login";
      notice = "Email confirmed. Log in to continue.";
      error = "";
      render();
    } catch (cause) {
      error = cause.message;
      render();
    }
  });
  document.querySelector("#resend")?.addEventListener("click", () => api("/api/resend", { method: "POST", body: { actor: "org", email: pendingEmail } }).catch((cause) => { error = cause.message; render(); }));
  watchPassword(document.querySelector("#signup"));
}

function readDraft(form) {
  const data = new FormData(form);
  draft.name = String(data.get("name") || "");
  draft.date = String(data.get("date") || "");
  draft.time = String(data.get("time") || "");
  draft.bio = String(data.get("bio") || "");
  draft.city = String(data.get("city") || "");
  draft.country = String(data.get("country") || "");
  const picked = data.get("tourPick");
  draft.tourPick = picked == null ? draft.tourPick : String(picked);
  if (draft.tourPick === "__new") draft.tourName = String(data.get("tourName") || "");
}

function readSend(form) {
  const data = new FormData(form);
  sendForm.label = String(data.get("label") || "");
  sendForm.message = String(data.get("message") || "");
  sendForm.expires = String(data.get("expires") || "");
  const format = data.get("format");
  if (format) sendForm.inPerson = format === "qr";
}

function readProfile(form) {
  if (!form) return;
  const data = new FormData(form);
  profileDraft = { name: String(data.get("name") || ""), kind: String(data.get("kind") || me?.kind || "band") };
}

function selectionKey() {
  if (sendForm.type === "tours") return "tours";
  if (sendForm.type === "places") return "names";
  return "gigIds";
}

function paintSummary() {
  const summary = document.querySelector("#pick-summary");
  if (!summary) return;
  const selected = sendForm[selectionKey()];
  summary.textContent = selected.length ? `${selected.length} selected` : "Choose";
}

function bindApp() {
  document.querySelectorAll("[data-signout]").forEach((button) => button.addEventListener("click", async () => {
    await api("/api/logout", { method: "POST", token, body: {} }).catch(() => undefined);
    localStorage.removeItem(tokenKey);
    token = null;
    gig = null;
    scanner = null;
    scanners = [];
    joinCode = "";
    clearInterval(joinTimer);
    error = "";
    notice = "";
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    render();
  }));
  document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => {
    const next = button.dataset.page;
    error = "";
    notice = "";
    goRoute({ page: next, id: "" }, { fresh: next === "create" || next === "send" || next === "profile" });
  }));
  document.querySelector("#go-create")?.addEventListener("click", () => {
    error = "";
    notice = "";
    goRoute({ page: "create", id: "" }, { fresh: true });
  });
  document.querySelector("#new-code")?.addEventListener("click", async () => {
    readProfile(document.querySelector("#profile"));
    try {
      const result = await api("/api/org/join-code", { method: "POST", token, body: {} });
      joinCode = result.code;
      joinExpires = new Date(result.expiresAt).getTime();
      error = "";
      startJoinClock();
    } catch (cause) {
      error = cause.message;
    }
    render();
  });
  document.querySelector("#create-event")?.addEventListener("input", (event) => readDraft(event.currentTarget));
  document.querySelector("#create-event")?.addEventListener("change", (event) => {
    const form = event.currentTarget;
    readDraft(form);
    if (event.target.name === "copyFrom") {
      const source = gigs.find((item) => item.id === event.target.value);
      if (!source) {
        draft.copyFrom = "";
        draft.copyLabel = "";
      } else {
        draft = {
          ...blankDraft(),
          name: source.name || "",
          bio: source.bio || "",
          city: source.city || "",
          country: source.country || "",
          tourPick: source.tourName || "",
          copyFrom: source.id,
          copyLabel: source.name || "the previous event",
        };
      }
      render();
      return;
    }
    if (event.target.name === "tourPick") render();
  });
  document.querySelector("#create-event")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    readDraft(event.currentTarget);
    if (!draft.date || !draft.time) {
      error = "Enter the date and start time.";
      render();
      return;
    }
    try {
      const image = await chosenImage("image", form.get("image"));
      if (!image && !draft.copyFrom) {
        error = "Add a picture.";
        render();
        return;
      }
      const tourName = draft.tourPick === "__new" ? draft.tourName : draft.tourPick;
      gig = await api("/api/gigs", {
        method: "POST",
        token,
        body: {
          name: draft.name,
          date: draft.date,
          time: draft.time,
          bio: draft.bio,
          city: draft.city,
          country: draft.country,
          tourName,
          ...(image ? { image } : {}),
          ...(draft.copyFrom ? { copyFrom: draft.copyFrom } : {}),
        },
      });
      heldFiles.image = "";
      draft = blankDraft();
      notice = "Event created.";
      error = "";
      await goRoute({ page: "event", id: gig.id });
    } catch (cause) {
      error = cause.message;
      render();
    }
  });
  document.querySelector("#show-past")?.addEventListener("change", (event) => {
    showPast = event.currentTarget.checked;
    render();
  });
  document.querySelectorAll("[data-gig]").forEach((button) => button.addEventListener("click", () => {
    error = "";
    notice = "";
    goRoute({ page: "event", id: button.dataset.gig });
  }));
  document.querySelector("#add-member")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      gig = await api(`/api/gigs/${gig.id}/members`, { method: "POST", token, body: { code: form.get("code") } });
      gigs = gigs.map((item) => item.id === gig.id ? { ...item, ...gig } : item);
      notice = "Added to the event.";
      error = "";
    } catch (cause) {
      error = cause.message;
    }
    render();
  });
  document.querySelectorAll("[data-receiver]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await api(`/api/gigs/${gig.id}/receivers/${button.dataset.receiver}`, { method: "DELETE", token });
        scanners = await api(`/api/gigs/${gig.id}/receivers`, { token });
        notice = "Scanner disconnected.";
        error = "";
      } catch (cause) {
        error = cause.message;
      }
      render();
    });
  });
  document.querySelector("#scanner-code")?.addEventListener("click", async () => {
    try {
      const result = await api(`/api/gigs/${gig.id}/scanner`, { method: "POST", token, body: {} });
      scanner = { gigId: gig.id, code: result.code, qr: result.qr };
      error = "";
      notice = "";
    } catch (cause) {
      error = cause.message;
    }
    render();
  });
  document.querySelector("#ask-delete")?.addEventListener("click", () => {
    confirmAction = "delete";
    render();
  });
  document.querySelector("#ask-end")?.addEventListener("click", () => {
    confirmAction = "end";
    render();
  });
  document.querySelector("#cancel-confirm")?.addEventListener("click", () => {
    confirmAction = "";
    render();
  });
  document.querySelector("#delete-event")?.addEventListener("click", async () => {
    try {
      await api(`/api/gigs/${gig.id}`, { method: "DELETE", token });
      gig = null;
      scanner = null;
      scanners = [];
      confirmAction = "";
      notice = "Event deleted.";
      error = "";
      await goRoute({ page: "events", id: "" });
    } catch (cause) {
      error = cause.message;
      render();
    }
  });
  document.querySelector("#go-live")?.addEventListener("click", async () => {
    try {
      gig = await api(`/api/gigs/${gig.id}/live`, { method: "POST", token, body: {} });
      gigs = gigs.map((item) => item.id === gig.id ? { ...item, ...gig } : item);
      scanners = [];
      notice = "This event is live.";
      error = "";
    } catch (cause) {
      error = cause.message;
    }
    render();
  });
  document.querySelector("#end-live")?.addEventListener("click", async () => {
    try {
      gig = await api(`/api/gigs/${gig.id}/live`, { method: "DELETE", token });
      gigs = gigs.map((item) => item.id === gig.id ? { ...item, ...gig } : item);
      scanner = null;
      scanners = [];
      confirmAction = "";
      notice = "Check-in has ended.";
      error = "";
    } catch (cause) {
      error = cause.message;
    }
    render();
  });
  document.querySelector("#send-to-event")?.addEventListener("click", () => {
    sendForm = { ...blankSend(), type: "events", gigIds: gig?.id ? [gig.id] : [], menuOpen: true };
    heldFiles.image = "";
    error = "";
    notice = "";
    goRoute({ page: "send", id: "" });
  });
  document.querySelector("#who-form")?.addEventListener("submit", (event) => event.preventDefault());
  document.querySelector("#who-form")?.addEventListener("change", (event) => {
    if (event.target.name === "type") {
      sendForm.type = String(event.target.value);
      sendForm.gigIds = [];
      sendForm.tours = [];
      sendForm.names = [];
      sendForm.menuOpen = false;
      sendForm.count = null;
      render();
      refreshCount();
      return;
    }
    if (event.target.name === "placeKind") {
      sendForm.placeKind = String(event.target.value);
      sendForm.names = [];
      sendForm.menuOpen = true;
      sendForm.count = null;
      render();
      refreshCount();
      return;
    }
    if (event.target.dataset.pick) {
      const id = event.target.dataset.pick;
      const key = selectionKey();
      sendForm[key] = event.target.checked ? [...new Set([...sendForm[key], id])] : sendForm[key].filter((item) => item !== id);
      sendForm.menuOpen = true;
      paintSummary();
      refreshCount();
    }
  });
  document.querySelector(".drop")?.addEventListener("toggle", (event) => {
    sendForm.menuOpen = event.currentTarget.open;
  });
  document.querySelector("#select-all")?.addEventListener("click", () => {
    const boxes = [...document.querySelectorAll("[data-pick]")];
    const allOn = boxes.length > 0 && boxes.every((box) => box.checked);
    const key = selectionKey();
    sendForm[key] = allOn ? [] : boxes.map((box) => box.dataset.pick);
    boxes.forEach((box) => { box.checked = !allOn; });
    sendForm.menuOpen = true;
    paintSummary();
    refreshCount();
  });
  document.querySelector("#add-audience")?.addEventListener("click", () => {
    const group = currentAudience();
    if (!group) {
      error = "Choose at least one.";
      render();
      return;
    }
    sendForm.extra.push({ ...group, id: String(Date.now()) });
    sendForm.type = "events";
    sendForm.gigIds = [];
    sendForm.tours = [];
    sendForm.names = [];
    sendForm.menuOpen = false;
    sendForm.count = null;
    error = "";
    render();
    refreshCount();
  });
  document.querySelectorAll("[data-remove]").forEach((button) => button.addEventListener("click", () => {
    sendForm.extra = sendForm.extra.filter((group) => group.id !== button.dataset.remove);
    sendForm.count = null;
    error = "";
    render();
    refreshCount();
  }));
  document.querySelector("#continue-send")?.addEventListener("click", () => {
    if (!countState().ready) return;
    sendForm.step = 2;
    error = "";
    render();
  });
  document.querySelector("#send-back")?.addEventListener("click", () => {
    readSend(document.querySelector("#send-form"));
    sendForm.step = 1;
    error = "";
    render();
    refreshCount();
  });
  document.querySelector("#send-form")?.addEventListener("input", (event) => readSend(event.currentTarget));
  document.querySelector("#send-form")?.addEventListener("change", (event) => {
    readSend(event.currentTarget);
  });
  document.querySelector("#send-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    readSend(event.currentTarget);
    const groups = payloadGroups();
    if (!groups.length) {
      error = "Choose who should receive this code.";
      sendForm.step = 1;
      render();
      return;
    }
    try {
      const image = await chosenImage("image", form.get("image"));
      if (!image) {
        error = "Add a picture.";
        render();
        return;
      }
      const result = await api("/api/codes", {
        method: "POST",
        token,
        body: {
          label: sendForm.label,
          message: sendForm.message,
          inPerson: sendForm.inPerson,
          expiresAt: sendForm.expires,
          image,
          groups,
        },
      });
      sendForm = blankSend();
      heldFiles.image = "";
      notice = `Sent to ${peopleLabel(result.count)}.`;
      error = "";
      await goRoute({ page: "issued", id: "" });
    } catch (cause) {
      error = cause.message;
      render();
    }
  });
  document.querySelector("#profile")?.addEventListener("input", (event) => readProfile(event.currentTarget));
  document.querySelector("#profile")?.addEventListener("change", (event) => readProfile(event.currentTarget));
  document.querySelector("#profile")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    readProfile(event.currentTarget);
    try {
      const picture = await chosenImage("picture", form.get("picture"));
      me = await api("/api/org/me", {
        method: "PATCH",
        token,
        body: { name: profileDraft.name, kind: profileDraft.kind, ...(picture ? { profileImage: picture } : {}) },
      });
      heldFiles.picture = "";
      profileDraft = null;
      notice = "Profile saved.";
      error = "";
    } catch (cause) {
      error = cause.message;
    }
    render();
  });
  document.querySelectorAll("input[type=file]").forEach((input) => {
    input.addEventListener("change", () => {
      const form = input.form;
      if (form?.id === "create-event") readDraft(form);
      if (form?.id === "send-form") readSend(form);
      if (form?.id === "profile") readProfile(form);
      holdFile(input);
    });
  });
  document.querySelectorAll("[data-csv]").forEach((button) => {
    button.addEventListener("click", () => downloadRelease(button.dataset.csv, button.dataset.filename));
  });
}

async function downloadRelease(batchId, filename) {
  try {
    const response = await fetch(resolve(`/api/codes/${batchId}`), {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.message || "That file could not be downloaded.");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename || "codes.csv";
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (cause) {
    error = cause.message;
    render();
  }
}

async function goRoute(route, options = {}) {
  const generation = ++routeGeneration;
  page = route.page;
  confirmAction = "";
  if (options.fresh) resetPageDraft(page);
  try {
    if (page === "event" || page === "events" || page === "create" || page === "send") {
      gigs = await api("/api/gigs", { token });
      if (generation !== routeGeneration) return;
    }
    if (page === "issued") {
      issued = await api("/api/codes", { token });
      if (generation !== routeGeneration) return;
    }
    if (page === "send") {
      audiencePlaces = await api("/api/places", { token }).catch(() => ({ cities: [], countries: [] }));
      if (generation !== routeGeneration) return;
    }
    if (page === "event") {
      const id = route.id || upcomingId();
      if (!id) {
        gig = null;
        scanner = null;
        scanners = [];
      } else {
        gig = await api(`/api/gigs/${id}`, { token });
        if (generation !== routeGeneration) return;
        if (scanner && scanner.gigId !== gig.id) scanner = null;
        scanners = gig.owner ? await api(`/api/gigs/${gig.id}/receivers`, { token }) : [];
        if (generation !== routeGeneration) return;
        gigs = gigs.map((item) => item.id === gig.id ? { ...item, ...gig } : item);
      }
    }
    if (generation !== routeGeneration) return;
    writeRoute();
    render();
    if (page === "send" && sendForm.step === 1) refreshCount();
  } catch (cause) {
    if (generation !== routeGeneration) return;
    error = cause.message;
    if (page === "event") {
      gig = null;
      scanners = [];
    }
    writeRoute();
    render();
  }
}

async function load() {
  me = await api("/api/org/me", { token });
  gigs = await api("/api/gigs", { token });
  await goRoute(readRoute());
}

window.addEventListener("hashchange", () => {
  if (!token) return;
  error = "";
  notice = "";
  goRoute(readRoute());
});

if (token) load().catch((cause) => {
  if (cause?.status === 401) {
    localStorage.removeItem(tokenKey);
    token = null;
  }
  render();
});
else render();
