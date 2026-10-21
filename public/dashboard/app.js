const tokenKey = "ticketid.org";
const app = document.querySelector("#app");
let token = localStorage.getItem(tokenKey);
let me = null;
let gigs = [];
let issued = [];
let page = "home";
let view = "login";
let gig = null;
let joinCode = "";
let joinExpires = 0;
let joinTimer = 0;
let scanner = null;
let error = "";
let notice = "";
let pendingEmail = sessionStorage.getItem("ticketid.org.pending") || "";
let hideCompleted = true;
let draft = blankDraft();
let sendForm = blankSend();

const kinds = [
  ["band", "Band"],
  ["team", "Sports team"],
  ["ensemble", "Ensemble"],
  ["organiser", "Organiser"],
  ["venue", "Venue"],
  ["festival", "Festival"],
];

function blankDraft() {
  return { name: "", date: "", time: "", bio: "", city: "", country: "", tourPick: "__new", tourName: "", copyFrom: "", copyLabel: "" };
}

function blankSend() {
  return { label: "", message: "", inPerson: false, expires: "", groups: [], type: "events", gigIds: [], tours: [], placeKind: "city", names: [], open: false, menuOpen: false };
}

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

function fileData(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.size) return resolve("");
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("That image could not be read."));
    reader.readAsDataURL(file);
  });
}

function tours() {
  return [...new Set(gigs.map((item) => item.tourName).filter(Boolean))].sort();
}

function places(kind) {
  const key = kind === "country" ? "country" : "city";
  return [...new Set(gigs.map((item) => item[key]).filter(Boolean))].sort();
}

function when(iso) {
  if (!iso) return "Date not set";
  const date = new Date(iso);
  return `${date.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()]} ${date.getFullYear()}`;
}

function eventChoiceLabel(item) {
  const name = item.name || "Untitled event";
  const shared = gigs.filter((gig) => (gig.name || "Untitled event") === name).length > 1;
  return shared ? `${name}, ${when(item.startsAt)}` : name;
}

function completed(item) {
  return Boolean(item.startsAt) && new Date(item.startsAt).getTime() < Date.now();
}

function canDelete(item) {
  return !item?.startsAt || !item.live;
}

function roleTitle(role) {
  if (role === "act") return "Bands";
  if (role === "venue") return "Venue";
  return role === "festival" ? "Festival" : "Organiser";
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
    : page === "profile" ? profileView()
    : homeView();
  app.innerHTML = `<header class="top"><p class="wordmark">ticket<span>ID</span></p><button class="ghost" id="signout" type="button">Sign out</button></header>${nav()}${body}`;
  bindApp();
}

function nav() {
  const items = [["home", "Home"], ["create", "Create event"], ["events", "Events"], ["send", "Send codes"], ["issued", "Issued codes"], ["profile", "Profile"]];
  return `<nav class="nav">${items.map(([id, label]) => `<button type="button" data-page="${id}" ${page === id ? "aria-current=\"page\"" : ""}>${label}</button>`).join("")}</nav>`;
}

function loginView() {
  return `<main class="stack"><p class="wordmark">ticket<span>ID</span></p><form class="stack" id="login">
    <label>Email<input name="email" type="email" required></label>
    <label>Password<input name="password" type="password" required></label>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <button class="primary" type="submit">Log in</button>
    <button class="ghost" id="to-signup" type="button">Create an account</button>
  </form></main>`;
}

function signupView() {
  return `<main class="stack"><p class="wordmark">ticket<span>ID</span></p><form class="stack" id="signup">
    <label>Account<select name="kind">${kinds.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>
    <label>Name<input name="name" required></label>
    <label>Email<input name="email" type="email" required></label>
    <label>Password<input name="password" type="password" required></label>
    <p class="hint">Use at least 8 characters, with one capital letter, one number, and one special character.</p>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <button class="primary" type="submit">Create account</button>
    <button class="ghost" id="to-login" type="button">I already have an account</button>
  </form></main>`;
}

function verifyView() {
  return `<main class="stack"><p class="wordmark">ticket<span>ID</span></p><form class="stack" id="verify">
    <p>We sent a message to ${esc(pendingEmail)}. Open the link, or enter the code.</p>
    <label>Code<input name="code" required></label>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <button class="primary" type="submit">Confirm email</button>
    <button class="ghost" id="resend" type="button">Send the email again</button>
  </form></main>`;
}

function homeView() {
  const seconds = joinCode ? Math.max(0, Math.ceil((joinExpires - Date.now()) / 1000)) : 0;
  if (!seconds) joinCode = "";
  return `<section class="stack">
    <button class="primary" id="new-code" type="button">Generate event code</button>
    ${joinCode ? `<p class="join-code">${esc(joinCode)}</p><p class="hint">${seconds}s</p>` : ""}
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
  </section>`;
}

function createView() {
  const previous = gigs.filter((item) => item.name);
  return `<section class="stack">
    <form class="stack" id="create-event">
      <label>Copy previous event<select name="copyFrom">
        <option value="">Start a blank event</option>
        ${previous.map((item) => `<option value="${esc(item.id)}" ${draft.copyFrom === item.id ? "selected" : ""}>${esc(item.name)}</option>`).join("")}
      </select></label>
      ${draft.copyLabel ? `<p class="hint">Using the picture from ${esc(draft.copyLabel)} unless you choose a new one. Date and start time are left blank.</p>` : ""}
      <label>Name<input name="name" value="${esc(draft.name)}" required></label>
      <div class="row">
        <label>Date<input name="date" type="date" value="${esc(draft.date)}"></label>
        <label>Time<input name="time" type="time" value="${esc(draft.time)}"></label>
      </div>
      <label>Bio<textarea name="bio">${esc(draft.bio)}</textarea></label>
      <label>Picture<input name="image" type="file" accept="image/png,image/jpeg,image/webp" ${draft.copyFrom ? "" : "required"}></label>
      <div class="row">
        <label>City<input name="city" value="${esc(draft.city)}"></label>
        <label>Country<input name="country" value="${esc(draft.country)}"></label>
      </div>
      <label>Tour or series<select name="tourPick">
        <option value="__new" ${draft.tourPick === "__new" ? "selected" : ""}>Create new</option>
        ${tours().map((name) => `<option value="${esc(name)}" ${draft.tourPick === name ? "selected" : ""}>${esc(name)}</option>`).join("")}
      </select></label>
      ${draft.tourPick === "__new" ? `<label>New tour or series<input name="tourName" value="${esc(draft.tourName)}"></label>` : ""}
      ${error ? `<p class="error">${esc(error)}</p>` : ""}
      <button class="primary" type="submit">Create event</button>
    </form></section>`;
}

function eventsView() {
  const shown = gigs.filter((item) => !hideCompleted || !completed(item));
  return `<section class="stack">
    <label class="choice"><input id="hide-completed" type="checkbox" ${hideCompleted ? "checked" : ""}> Do not show completed events</label>
    <div class="event-grid">${shown.map((item) => `<button class="event-tile" type="button" data-gig="${esc(item.id)}">
      ${item.image ? `<img alt="" src="${esc(item.image)}">` : `<span class="event-fallback"></span>`}
      <strong>${esc(item.name || "Untitled event")}</strong>
      <small>${esc(when(item.startsAt))}${item.live ? "" : " · Not live"}</small>
    </button>`).join("") || `<p class="hint">No events to show.</p>`}</div>
  </section>`;
}

function eventView() {
  if (!gig) return `<p class="hint">That event is not available.</p>`;
  const groups = ["act", "venue", "festival", "organiser"].filter((role) => gig.members.some((member) => member.role === role));
  return `<section class="stack"><h1>${esc(gig.name || "Untitled event")}</h1>
    ${gig.image ? `<img class="cover" alt="" src="${esc(gig.image)}">` : ""}
    <p>${esc(when(gig.startsAt))}${gig.city || gig.country ? ` · ${esc([gig.city, gig.country].filter(Boolean).join(", "))}` : ""}</p>
    ${gig.bio ? `<p>${esc(gig.bio)}</p>` : ""}
    ${gig.tourName ? `<p class="hint">${esc(gig.tourName)}</p>` : ""}
    ${groups.map((role) => `<div><h2>${roleTitle(role)}</h2><p class="members">${gig.members.filter((member) => member.role === role).map((member) => esc(member.name)).join("<br>")}</p></div>`).join("")}
    <form class="row" id="add-member">
      <label>Add to event<input name="code" autocapitalize="characters" required></label>
      <button class="primary" type="submit">Add</button>
    </form>
    ${gig.live ? `<div class="stack door">
      <button class="primary" id="scanner-code" type="button">Generate scanner code</button>
      ${scanner?.gigId === gig.id ? `<p class="join-code">${esc(scanner.code)}</p>
        ${scanner.qr ? `<img class="door-qr" alt="Scanner code" src="${esc(scanner.qr)}">` : ""}
        <p class="hint">This works once. The scanner types it, or scans it, to join this event. Logging out needs a new code.</p>` : `<p class="hint">A scanner code is created when you ask for one. It is not kept on this page.</p>`}
    </div>` : `<button class="primary" id="go-live" type="button">Go live</button>`}
    ${canDelete(gig) ? `<button class="ghost" id="delete-event" type="button">Delete event</button>` : ""}
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    ${notice ? `<p class="hint">${esc(notice)}</p>` : ""}
  </section>`;
}

function sendView() {
  if (!sendForm.open) {
    return `<section class="stack">
      <button class="primary" id="new-send" type="button">New code</button>
      ${error ? `<p class="error">${esc(error)}</p>` : ""}
      ${notice ? `<p class="hint">${esc(notice)}</p>` : ""}
    </section>`;
  }
  const choices = sendForm.type === "tours" ? tours() : sendForm.type === "places" ? places(sendForm.placeKind) : gigs.filter((item) => item.name);
  const selected = sendForm.type === "tours" ? sendForm.tours : sendForm.type === "places" ? sendForm.names : sendForm.gigIds;
  return `<section class="stack"><form class="stack" id="send-form">
    <label>Name<input name="label" value="${esc(sendForm.label)}" placeholder="2027 World Tour" required></label>
    <label>Add a group<select name="type">
      <option value="events" ${sendForm.type === "events" ? "selected" : ""}>Attendees of specific events</option>
      <option value="tours" ${sendForm.type === "tours" ? "selected" : ""}>Attendees of specific tour/series</option>
      <option value="places" ${sendForm.type === "places" ? "selected" : ""}>Fans from specified countries/cities</option>
      <option value="all" ${sendForm.type === "all" ? "selected" : ""}>All fans</option>
    </select></label>
    ${sendForm.type === "places" ? `<label>Cities or countries<select name="placeKind">
      <option value="city" ${sendForm.placeKind === "city" ? "selected" : ""}>Cities</option>
      <option value="country" ${sendForm.placeKind === "country" ? "selected" : ""}>Countries</option>
    </select></label>` : ""}
    ${sendForm.type === "all" ? "" : `<details class="drop" ${sendForm.menuOpen ? "open" : ""}>
      <summary>${selected.length ? `${selected.length} selected` : "Choose"}</summary>
      <div class="drop-list">
        <button class="ghost sticky" id="select-all" type="button">Select all</button>
        ${choices.map((item) => {
          const id = sendForm.type === "events" ? item.id : item;
          const label = sendForm.type === "events" ? eventChoiceLabel(item) : item;
          return `<label class="choice"><input type="checkbox" data-pick="${esc(id)}" ${selected.includes(id) ? "checked" : ""}> ${esc(label)}</label>`;
        }).join("") || `<p class="hint">Nothing to choose yet.</p>`}
      </div>
    </details>`}
    <button class="ghost" id="add-group" type="button">Add group</button>
    <ul class="groups">${sendForm.groups.map((group) => `<li><span>${esc(group.label)}</span><button type="button" data-remove="${esc(group.id)}" aria-label="Remove group">×</button></li>`).join("")}</ul>
    <label>Message<textarea name="message" required>${esc(sendForm.message)}</textarea></label>
    <fieldset class="choice-set"><legend>Code</legend>
      <label class="choice"><input name="format" type="radio" value="text" ${sendForm.inPerson ? "" : "checked"}> Text</label>
      <label class="choice"><input name="format" type="radio" value="qr" ${sendForm.inPerson ? "checked" : ""}> QR code</label>
    </fieldset>
    <label>Tile picture<input name="image" type="file" accept="image/png,image/jpeg,image/webp" required></label>
    <label>Expiry<input name="expires" type="date" value="${esc(sendForm.expires)}" required></label>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <button class="primary" type="submit">Send codes</button>
  </form></section>`;
}

function issuedView() {
  return `<section class="stack">
    ${issued.length ? `<ul class="issued">${issued.map((item) => `<li>
      ${item.image ? `<img alt="" src="${esc(item.image)}">` : ""}
      <div><strong>${esc(item.label)}</strong><p>${esc(item.message)}</p><p class="hint">${item.count} people · ${item.inPerson ? "QR code" : "Text"} · ${item.expiresAt ? `Expires ${esc(when(item.expiresAt))}` : "No expiry"}</p></div>
    </li>`).join("")}</ul>` : `<p class="hint">Codes you send will be listed here.</p>`}
  </section>`;
}

function profileView() {
  return `<section class="stack"><form class="stack" id="profile">
    ${me?.profileImage ? `<img class="profile-pic" alt="" src="${esc(me.profileImage)}">` : ""}
    <label>Name<input name="name" value="${esc(me?.name)}" required></label>
    <label>You are a<select name="kind">${kinds.map(([value, label]) => `<option value="${value}" ${me?.kind === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
    <label>Profile picture<input name="picture" type="file" accept="image/png,image/jpeg,image/webp"></label>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    ${notice ? `<p class="hint">${esc(notice)}</p>` : ""}
    <button class="primary" type="submit">Save profile</button>
  </form></section>`;
}

function bindAuth() {
  document.querySelector("#to-signup")?.addEventListener("click", () => { view = "signup"; error = ""; render(); });
  document.querySelector("#to-login")?.addEventListener("click", () => { view = "login"; error = ""; render(); });
  document.querySelector("#login")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await api("/api/org/login", { method: "POST", body: { email: form.get("email"), password: form.get("password") } });
      token = result.token;
      localStorage.setItem(tokenKey, token);
      error = "";
      await load();
    } catch (cause) {
      error = cause.message;
      if (cause.message.includes("Confirm your email")) {
        pendingEmail = String(form.get("email") || "");
        sessionStorage.setItem("ticketid.org.pending", pendingEmail);
      }
      render();
    }
  });
  document.querySelector("#signup")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    try {
      await api("/api/org/signup", { method: "POST", body });
      pendingEmail = body.email;
      sessionStorage.setItem("ticketid.org.pending", pendingEmail);
      error = "";
      render();
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
      error = "";
      render();
    } catch (cause) {
      error = cause.message;
      render();
    }
  });
  document.querySelector("#resend")?.addEventListener("click", () => api("/api/resend", { method: "POST", body: { actor: "org", email: pendingEmail } }).catch((cause) => { error = cause.message; render(); }));
}

function readDraft(form) {
  const data = new FormData(form);
  draft.name = String(data.get("name") || "");
  draft.date = String(data.get("date") || "");
  draft.time = String(data.get("time") || "");
  draft.bio = String(data.get("bio") || "");
  draft.city = String(data.get("city") || "");
  draft.country = String(data.get("country") || "");
  draft.tourPick = String(data.get("tourPick") || "__new");
  if (draft.tourPick === "__new") draft.tourName = String(data.get("tourName") || "");
}

function bindApp() {
  document.querySelector("#signout")?.addEventListener("click", async () => {
    await api("/api/logout", { method: "POST", token, body: {} }).catch(() => undefined);
    localStorage.removeItem(tokenKey);
    token = null;
    gig = null;
    render();
  });
  document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", async () => {
    page = button.dataset.page;
    error = "";
    notice = "";
    scanner = null;
    if (page === "events") hideCompleted = true;
    if (page === "issued") issued = await api("/api/codes", { token }).catch(() => []);
    if (page === "create") draft = blankDraft();
    render();
  }));
  document.querySelector("#new-code")?.addEventListener("click", async () => {
    try {
      const result = await api("/api/org/join-code", { method: "POST", token, body: {} });
      joinCode = result.code;
      joinExpires = new Date(result.expiresAt).getTime();
      error = "";
      clearInterval(joinTimer);
      joinTimer = setInterval(() => {
        if (Date.now() >= joinExpires) {
          joinCode = "";
          clearInterval(joinTimer);
        }
        if (page === "home") render();
      }, 1000);
    } catch (cause) {
      error = cause.message;
    }
    render();
  });
  document.querySelector("#create-event")?.addEventListener("change", (event) => {
    const form = event.currentTarget;
    readDraft(form);
    if (event.target.name === "copyFrom") {
      const source = gigs.find((item) => item.id === event.target.value);
      if (!source) {
        draft.copyFrom = "";
        draft.copyLabel = "";
      } else {
        draft = { ...blankDraft(), name: source.name || "", bio: source.bio || "", city: source.city || "", country: source.country || "", tourPick: source.tourName || "__new", tourName: "", copyFrom: source.id, copyLabel: source.name || "the previous event" };
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
    try {
      const image = await fileData(form.get("image"));
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
      gigs = await api("/api/gigs", { token });
      page = "event";
      error = "";
      notice = "Event created.";
      render();
    } catch (cause) {
      error = cause.message;
      render();
    }
  });
  document.querySelector("#hide-completed")?.addEventListener("change", (event) => {
    hideCompleted = event.currentTarget.checked;
    render();
  });
  document.querySelectorAll("[data-gig]").forEach((button) => button.addEventListener("click", async () => {
    try {
      gig = await api(`/api/gigs/${button.dataset.gig}`, { token });
      scanner = null;
      page = "event";
      error = "";
      notice = "";
      render();
    } catch (cause) {
      error = cause.message;
      render();
    }
  }));
  document.querySelector("#add-member")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      gig = await api(`/api/gigs/${gig.id}/members`, { method: "POST", token, body: { code: form.get("code") } });
      gigs = await api("/api/gigs", { token });
      notice = "Added to the event.";
      error = "";
      render();
    } catch (cause) {
      error = cause.message;
      render();
    }
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
  document.querySelector("#delete-event")?.addEventListener("click", async () => {
    if (!window.confirm("Delete this event?")) return;
    try {
      await api(`/api/gigs/${gig.id}`, { method: "DELETE", token });
      gigs = await api("/api/gigs", { token });
      gig = null;
      scanner = null;
      page = "events";
      hideCompleted = true;
      error = "";
      notice = "Event deleted.";
    } catch (cause) {
      error = cause.message;
    }
    render();
  });
  document.querySelector("#go-live")?.addEventListener("click", async () => {
    try {
      gig = await api(`/api/gigs/${gig.id}/live`, { method: "POST", token, body: {} });
      gigs = await api("/api/gigs", { token });
      notice = "This event is live.";
      error = "";
      render();
    } catch (cause) {
      error = cause.message;
      render();
    }
  });
  document.querySelector("#new-send")?.addEventListener("click", () => {
    sendForm = { ...blankSend(), open: true };
    error = "";
    notice = "";
    render();
  });
  document.querySelector("#send-form")?.addEventListener("change", (event) => {
    const form = event.currentTarget;
    const data = new FormData(form);
    sendForm.label = String(data.get("label") || "");
    sendForm.message = String(data.get("message") || "");
    sendForm.expires = String(data.get("expires") || "");
    sendForm.inPerson = data.get("format") === "qr";
    if (event.target.name === "type") {
      sendForm.type = String(data.get("type"));
      sendForm.gigIds = [];
      sendForm.tours = [];
      sendForm.names = [];
      sendForm.menuOpen = false;
      render();
    }
    if (event.target.name === "placeKind") {
      sendForm.placeKind = String(data.get("placeKind"));
      sendForm.names = [];
      sendForm.menuOpen = true;
      render();
    }
    if (event.target.dataset.pick) {
      const id = event.target.dataset.pick;
      const key = sendForm.type === "tours" ? "tours" : sendForm.type === "places" ? "names" : "gigIds";
      sendForm[key] = event.target.checked ? [...new Set([...sendForm[key], id])] : sendForm[key].filter((item) => item !== id);
    }
  });
  document.querySelector(".drop")?.addEventListener("toggle", (event) => {
    sendForm.menuOpen = event.currentTarget.open;
  });
  document.querySelector("#select-all")?.addEventListener("click", () => {
    const boxes = [...document.querySelectorAll("[data-pick]")];
    const allOn = boxes.length > 0 && boxes.every((box) => box.checked);
    const key = sendForm.type === "tours" ? "tours" : sendForm.type === "places" ? "names" : "gigIds";
    sendForm[key] = allOn ? [] : boxes.map((box) => box.dataset.pick);
    sendForm.menuOpen = true;
    render();
  });
  document.querySelector("#add-group")?.addEventListener("click", () => {
    const id = String(Date.now());
    if (sendForm.type === "all") sendForm.groups.push({ id, type: "all", label: "All fans" });
    else if (sendForm.type === "events" && sendForm.gigIds.length) {
      const names = gigs.filter((item) => sendForm.gigIds.includes(item.id)).map((item) => eventChoiceLabel(item)).join(" · ");
      sendForm.groups.push({ id, type: "events", gigIds: [...sendForm.gigIds], label: `Events: ${names}` });
    } else if (sendForm.type === "tours" && sendForm.tours.length) sendForm.groups.push({ id, type: "tours", tours: [...sendForm.tours], label: `Tours: ${sendForm.tours.join(", ")}` });
    else if (sendForm.type === "places" && sendForm.names.length) sendForm.groups.push({ id, type: "places", names: [...sendForm.names], label: `${sendForm.placeKind === "country" ? "Countries" : "Cities"}: ${sendForm.names.join(", ")}` });
    else {
      error = "Choose at least one.";
      render();
      return;
    }
    error = "";
    render();
  });
  document.querySelectorAll("[data-remove]").forEach((button) => button.addEventListener("click", () => {
    sendForm.groups = sendForm.groups.filter((group) => group.id !== button.dataset.remove);
    render();
  }));
  document.querySelector("#send-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (!sendForm.groups.length) {
      error = "Add at least one group.";
      render();
      return;
    }
    try {
      const image = await fileData(form.get("image"));
      const result = await api("/api/codes", {
        method: "POST",
        token,
        body: {
          label: form.get("label"),
          message: form.get("message"),
          inPerson: form.get("format") === "qr",
          expiresAt: form.get("expires"),
          image,
          groups: sendForm.groups.map(({ type, gigIds, tours, names }) => ({ type, gigIds, tours, names })),
        },
      });
      sendForm = blankSend();
      notice = `Sent to ${result.count} people.`;
      error = "";
      issued = await api("/api/codes", { token });
      page = "issued";
      render();
    } catch (cause) {
      error = cause.message;
      render();
    }
  });
  document.querySelector("#profile")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const picture = await fileData(form.get("picture"));
      me = await api("/api/org/me", { method: "PATCH", token, body: { name: form.get("name"), kind: form.get("kind"), ...(picture ? { profileImage: picture } : {}) } });
      notice = "Profile saved.";
      error = "";
      render();
    } catch (cause) {
      error = cause.message;
      render();
    }
  });
}

async function load() {
  me = await api("/api/org/me", { token });
  gigs = await api("/api/gigs", { token });
  page = "home";
  render();
}

if (token) load().catch(() => { localStorage.removeItem(tokenKey); token = null; render(); });
else render();
