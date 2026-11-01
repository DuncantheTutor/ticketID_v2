import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { createApp, resetData } from "./app.js";

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function boot() {
  await resetData();
  const server = await new Promise((resolve) => {
    const listening = createApp().listen(0, "127.0.0.1", () => resolve(listening));
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function shutdown(started) {
  await new Promise((resolve) => started.server.close(resolve));
}

async function call(base, pathname, { method = "GET", token, body } = {}) {
  const response = await fetch(base + pathname, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function mailCode(base, email) {
  const message = await call(base, `/api/dev/mail?email=${encodeURIComponent(email)}`);
  const found = String(message.data.body || "").match(/[?&]oobCode=([^&\s]+)/);
  assert.ok(found, message.data.body);
  return decodeURIComponent(found[1]);
}

async function mailPin(base, to) {
  const message = await call(base, `/api/dev/mail?email=${encodeURIComponent(to)}`);
  const found = String(message.data.body || "").match(/Your ticketID code is (\d{6})/);
  assert.ok(found, message.data.body);
  return found[1];
}

async function confirmMail(base, email, actor = "fan") {
  const code = await mailPin(base, email);
  const verified = await call(base, "/api/verify", { method: "POST", body: { actor, email, code } });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  return verified.data;
}

function phoneFor(email) {
  const digits = sha(email).replace(/\D/g, "").padEnd(10, "0").slice(0, 10);
  return `07${digits}`;
}

async function fan(base, details) {
  const deviceId = details.deviceId || randomUUID();
  const phone = details.phone || phoneFor(details.email);
  const signup = await call(base, "/api/fan/signup", { method: "POST", body: { password: "Password1!", confirm: "Password1!", phone, ...details, deviceId } });
  assert.equal(signup.status, 200, JSON.stringify(signup.data));
  assert.equal(signup.data.needsVerify, true);
  assert.equal(signup.data.token, undefined);
  await confirmMail(base, details.email, "fan");
  const logged = await call(base, "/api/fan/login", { method: "POST", body: { email: details.email, password: "Password1!", deviceId } });
  assert.equal(logged.status, 200, JSON.stringify(logged.data));
  assert.ok(logged.data.token);
  return logged.data.token;
}

async function org(base, details) {
  const signup = await call(base, "/api/org/signup", { method: "POST", body: { password: "Password1!", confirm: "Password1!", ...details } });
  assert.equal(signup.status, 200, JSON.stringify(signup.data));
  assert.equal(signup.data.needsVerify, true);
  assert.equal(signup.data.token, undefined);
  await confirmMail(base, details.email, "org");
  const logged = await call(base, "/api/org/login", { method: "POST", body: { email: details.email, password: "Password1!" } });
  assert.equal(logged.status, 200, JSON.stringify(logged.data));
  const picture = await call(base, "/api/org/me", { method: "PATCH", token: logged.data.token, body: { profileImage: png } });
  assert.equal(picture.status, 200, JSON.stringify(picture.data));
  return logged.data.token;
}

test("a fan can register and sign in with email and password", async () => {
  const started = await boot();
  try {
  const mismatch = await call(started.url, "/api/fan/signup", { method: "POST", body: { username: "ada", email: "ada@example.com", phone: "07000900000", password: "Password1!", confirm: "Password2!" } });
  assert.equal(mismatch.status, 400);
  const deviceId = randomUUID();
  const signup = await call(started.url, "/api/fan/signup", { method: "POST", body: { username: "ada", email: "ada@example.com", phone: "07000900000", password: "Password1!", confirm: "Password1!", deviceId } });
  assert.equal(signup.status, 200, JSON.stringify(signup.data));
  assert.equal(signup.data.needsVerify, true);
  assert.equal(signup.data.token, undefined);
  const closed = await call(started.url, "/api/fan/me");
  assert.equal(closed.status, 401);
  const before = await call(started.url, "/api/fan/login", { method: "POST", body: { email: "ada@example.com", password: "Password1!", deviceId } });
  assert.equal(before.status, 200, JSON.stringify(before.data));
  assert.equal(before.data.needsVerify, true);
  assert.equal(before.data.token, undefined);
  await confirmMail(started.url, "ada@example.com");
  const me = await call(started.url, "/api/fan/me", { token: signup.data.token });
  assert.equal(me.status, 401);
  const logged = await call(started.url, "/api/fan/login", { method: "POST", body: { email: "ada@example.com", password: "Password1!", deviceId } });
  assert.equal(logged.status, 200, JSON.stringify(logged.data));
  const profile = await call(started.url, "/api/fan/me", { token: logged.data.token });
  assert.equal(profile.status, 200, JSON.stringify(profile.data));
  assert.equal(profile.data.email, "ada@example.com");
  assert.equal(profile.data.emailVerified, true);
  const wrong = await call(started.url, "/api/fan/login", { method: "POST", body: { email: "ada@example.com", password: "nope" } });
  assert.equal(wrong.status, 401);
  const taken = await call(started.url, "/api/fan/signup", { method: "POST", body: { username: "ada2", email: "ada2@example.com", phone: "07000900000", password: "Password1!", confirm: "Password1!", deviceId: randomUUID() } });
  assert.equal(taken.status, 400);
  } finally {
    await shutdown(started);
  }
});

test("a scan proves a fan and a priority code reaches only that account", async () => {
  const previous = process.env.CHECKIN_MS;
  process.env.CHECKIN_MS = "10000";
  const started = await boot();
  try {
  const venue = await org(started.url, { kind: "venue", name: "The Room", email: "room@example.com" });
  const labeled = await call(started.url, "/api/org/me", {
    method: "PATCH",
    token: venue,
    body: {
      profileImage: "data:image/jpeg;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    },
  });
  assert.equal(labeled.status, 400);
  const band = await org(started.url, { kind: "band", name: "Night Bus", email: "bus@example.com" });
  const stranger = await org(started.url, { kind: "band", name: "Other", email: "other@example.com" });
  const fanToken = await fan(started.url, { username: "mina", email: "mina@example.com", hometown: "Hackney", city: "London" });
  const opted = await fan(started.url, { username: "otto", email: "otto@example.com", city: "London" });
  const unlocked = await call(started.url, "/api/fan/me", { method: "PATCH", token: opted, body: { registeredOnly: true } });
  assert.equal(unlocked.status, 200, JSON.stringify(unlocked.data));
  assert.equal(unlocked.data.registeredOnly, true);

  const created = await call(started.url, "/api/gigs", { method: "POST", token: venue, body: {} });
  const gigId = created.data.id;
  const bandCode = await call(started.url, "/api/org/join-code", { method: "POST", token: band, body: {} });
  const added = await call(started.url, `/api/gigs/${gigId}/acts`, { method: "POST", token: venue, body: { code: bandCode.data.code } });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  assert.equal(added.data.owner, true);
  const bandView = await call(started.url, `/api/gigs/${gigId}`, { token: band });
  assert.equal(bandView.status, 200);
  assert.equal(bandView.data.owner, false);
  const bandEdit = await call(started.url, `/api/gigs/${gigId}`, { method: "PATCH", token: band, body: { name: "Taken over" } });
  assert.equal(bandEdit.status, 403);
  const bandLive = await call(started.url, `/api/gigs/${gigId}/live`, { method: "POST", token: band, body: {} });
  assert.equal(bandLive.status, 403);
  const again = await call(started.url, `/api/gigs/${gigId}/acts`, { method: "POST", token: venue, body: { code: bandCode.data.code } });
  assert.equal(again.status, 400, JSON.stringify(again.data));
  const saved = await call(started.url, `/api/gigs/${gigId}`, {
    method: "PATCH",
    token: venue,
    body: { name: "Night Bus at The Room", date: "2026-11-02", time: "20:00", bio: "A Monday.", image: png, tourName: "Autumn" },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.startsAt, "2026-11-02T20:00");
  assert.equal(saved.data.ready, true);
  assert.equal(saved.data.live, false);

  const opened = await call(started.url, `/api/gigs/${gigId}/live`, { method: "POST", token: venue, body: {} });
  assert.equal(opened.status, 200);
  assert.equal(opened.data.live, true);
  assert.equal(opened.data.eventCode, undefined);

  const draft = await call(started.url, "/api/gigs", { method: "POST", token: venue, body: { name: "Untitled night" } });
  const removed = await call(started.url, `/api/gigs/${draft.data.id}`, { method: "DELETE", token: venue });
  assert.equal(removed.status, 200);
  const kept = await call(started.url, `/api/gigs/${gigId}`, { method: "DELETE", token: venue });
  assert.equal(kept.status, 409);

  const blocked = await call(started.url, "/api/receiver/login", { method: "POST", body: { code: "NOPE" } });
  assert.equal(blocked.status, 401);
  const pass = await call(started.url, `/api/gigs/${gigId}/scanner`, { method: "POST", token: venue, body: {} });
  assert.equal(pass.status, 200);
  const receiver = await call(started.url, "/api/receiver/login", { method: "POST", body: { code: `ticketid:${pass.data.code.toLowerCase()}` } });
  assert.equal(receiver.status, 200);
  const reused = await call(started.url, "/api/receiver/login", { method: "POST", body: { code: pass.data.code } });
  assert.equal(reused.status, 401);

  const minted = await call(started.url, "/api/fan/checkin", { method: "POST", token: fanToken, body: {} });
  assert.match(minted.data.qr, /^data:image\/png/);
  const scanned = await call(started.url, "/api/receiver/scan", { method: "POST", token: receiver.data.token, body: { code: minted.data.code } });
  assert.equal(scanned.status, 200);
  const replay = await call(started.url, "/api/receiver/scan", { method: "POST", token: receiver.data.token, body: { code: minted.data.code } });
  assert.equal(replay.status, 400);
  const status = await call(started.url, `/api/fan/checkin/${minted.data.id}`, { token: fanToken });
  assert.equal(status.data.status, "registered");
  assert.equal(status.data.gigName, "Night Bus at The Room");
  const counted = await call(started.url, `/api/gigs/${gigId}`, { token: venue });
  assert.equal(counted.data.registered, 1);
  const catalogue = await call(started.url, "/api/gigs", { token: venue });
  assert.equal(catalogue.data.find((item) => item.id === gigId).registered, 1);
  const preview = await call(started.url, "/api/codes/preview", {
    method: "POST",
    token: band,
    body: { groups: [{ type: "events", gigIds: [gigId] }] },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.count, 1);

  process.env.CHECKIN_MS = "250";
  const expiredMint = await call(started.url, "/api/fan/checkin", { method: "POST", token: opted, body: {} });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const expired = await call(started.url, "/api/receiver/scan", { method: "POST", token: receiver.data.token, body: { code: expiredMint.data.code } });
  assert.equal(expired.status, 400);

  const denied = await call(started.url, "/api/codes", { method: "POST", token: stranger, body: { group: "gig", gigId, label: "Priority" } });
  assert.equal(denied.status, 403);
  const sent = await call(started.url, "/api/codes", { method: "POST", token: band, body: { group: "gig", gigId, label: "Priority access" } });
  assert.equal(sent.data.count, 1);
  assert.equal(sent.data.filename, "Priority access.csv");
  const file = await fetch(`${started.url}/api/codes/${sent.data.batch}`, { headers: { authorization: `Bearer ${band}` } });
  assert.equal(file.status, 200);
  assert.match(file.headers.get("content-disposition") || "", /Priority access\.csv/);
  const text = await file.text();
  const codes = await call(started.url, "/api/fan/codes", { token: fanToken });
  assert.equal(codes.data.length, 1);
  assert.equal(codes.data[0].label, "Priority access");
  assert.match(text, /sha256,username,groups/);
  assert.match(text, /mina/);
  assert.match(text, /Attendees of Night Bus at The Room/);
  const csvRow = text.split(/\r?\n/).find((line) => line.includes("mina"));
  assert.ok(csvRow);
  assert.equal(csvRow.split(",")[0], sha(codes.data[0].code));
  const device = await call(started.url, "/api/fan/device", { method: "POST", token: fanToken, body: { token: "fan-phone" } });
  assert.equal(device.status, 200, JSON.stringify(device.data));
  const optedCodes = await call(started.url, "/api/fan/codes", { token: opted });
  assert.equal(optedCodes.data.length, 0);

  const place = await call(started.url, "/api/codes", { method: "POST", token: band, body: { group: "place", place: "London", label: "Next London show", inPerson: true } });
  assert.equal(place.data.count, 1);
  const afterPlace = await call(started.url, "/api/fan/codes", { token: fanToken });
  assert.equal(afterPlace.data.length, 2);
  const london = afterPlace.data.find((item) => item.label === "Next London show");
  assert.equal(london.inPerson, true);
  assert.match(london.qr, /^data:image\/png/);
  const priority = afterPlace.data.find((item) => item.label === "Priority access");
  assert.equal(priority.inPerson, false);
  assert.equal(priority.qr, null);
  const stillOpted = await call(started.url, "/api/fan/codes", { token: opted });
  assert.equal(stillOpted.data.length, 0);

  const gigs = await call(started.url, "/api/fan/gigs", { token: fanToken });
  assert.equal(gigs.data[0].name, "Night Bus at The Room");

  const door = await call(started.url, `/api/gigs/${gigId}/receivers`, { token: venue });
  assert.equal(door.status, 200);
  assert.equal(door.data.length, 1);
  const extra = await call(started.url, `/api/gigs/${gigId}/scanner`, { method: "POST", token: venue, body: {} });
  const other = await call(started.url, "/api/receiver/login", { method: "POST", body: { code: extra.data.code } });
  assert.equal(other.status, 200);
  const stillThere = await call(started.url, "/api/receiver/event", { token: receiver.data.token });
  assert.equal(stillThere.status, 200);
  const doors = await call(started.url, `/api/gigs/${gigId}/receivers`, { token: venue });
  assert.equal(doors.data.length, 2);
  const hidden = await call(started.url, `/api/gigs/${gigId}/receivers`, { token: band });
  assert.equal(hidden.status, 403);
  const cut = await call(started.url, `/api/gigs/${gigId}/receivers/${door.data[0].id}`, { method: "DELETE", token: venue });
  assert.equal(cut.status, 200);
  const closed = await call(started.url, "/api/receiver/event", { token: receiver.data.token });
  assert.equal(closed.status, 401);
  const stays = await call(started.url, "/api/receiver/event", { token: other.data.token });
  assert.equal(stays.status, 200);

  } finally {
    await shutdown(started);
    if (previous === undefined) delete process.env.CHECKIN_MS;
    else process.env.CHECKIN_MS = previous;
  }
});

test("a fan changes a password and can recover it by email or phone", async () => {
  const started = await boot();
  try {
  const deviceId = randomUUID();
  const token = await fan(started.url, { username: "ada", email: "ada@example.com", phone: "07000900000", deviceId });
  const weak = await call(started.url, "/api/fan/password", { method: "POST", token, body: { currentPassword: "Password1!", password: "password1", confirm: "password1" } });
  assert.equal(weak.status, 400);
  const wrong = await call(started.url, "/api/fan/password", { method: "POST", token, body: { currentPassword: "nope", password: "Password2!", confirm: "Password2!" } });
  assert.equal(wrong.status, 401);
  const mismatch = await call(started.url, "/api/fan/password", { method: "POST", token, body: { currentPassword: "Password1!", password: "Password2!", confirm: "Password3!" } });
  assert.equal(mismatch.status, 400);
  const changed = await call(started.url, "/api/fan/password", { method: "POST", token, body: { currentPassword: "Password1!", password: "Password2!", confirm: "Password2!" } });
  assert.equal(changed.status, 200);
  const logged = await call(started.url, "/api/fan/login", { method: "POST", body: { email: "ada@example.com", password: "Password2!", deviceId } });
  assert.equal(logged.status, 200);

  const missing = await call(started.url, "/api/fan/recover", { method: "POST", body: { contact: "nobody@example.com" } });
  assert.equal(missing.status, 200);
  assert.equal(missing.data.email, undefined);
  const sent = await call(started.url, "/api/fan/recover", { method: "POST", body: { contact: "07000900000" } });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.email, undefined);
  assert.equal(sent.data.ok, true);
  const code = await mailCode(started.url, "ada@example.com");
  const weakLink = await call(started.url, "/api/fan/recover/confirm", { method: "POST", body: { oobCode: code, password: "password", confirm: "password" } });
  assert.equal(weakLink.status, 400);
  const resetMismatch = await call(started.url, "/api/fan/recover/confirm", { method: "POST", body: { oobCode: code, password: "Password3!", confirm: "Password4!" } });
  assert.equal(resetMismatch.status, 400);
  const reset = await call(started.url, "/api/fan/recover/confirm", { method: "POST", body: { oobCode: code, password: "Password3!", confirm: "Password3!" } });
  assert.equal(reset.status, 200);
  const oldPassword = await call(started.url, "/api/fan/login", { method: "POST", body: { email: "ada@example.com", password: "Password2!", deviceId } });
  assert.equal(oldPassword.status, 401);
  const again = await call(started.url, "/api/fan/login", { method: "POST", body: { email: "ada@example.com", password: "Password3!", deviceId } });
  assert.equal(again.status, 200);

  const saved = await call(started.url, "/api/fan/me", { method: "PATCH", token: again.data.token, body: { city: "London", country: "United Kingdom", email: "ada@example.com" } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.city, "London");
  assert.equal(saved.data.country, "United Kingdom");
  assert.equal(saved.data.email, "ada@example.com");
  assert.equal(saved.data.hometown, undefined);

  } finally {
    await shutdown(started);
  }
});

async function openDoor(base, orgToken, fields = {}) {
  const created = await call(base, "/api/gigs", { method: "POST", token: orgToken, body: {} });
  const gigId = created.data.id;
  const saved = await call(base, `/api/gigs/${gigId}`, {
    method: "PATCH",
    token: orgToken,
    body: { name: "Night", date: "2026-11-02", time: "20:00", image: png, ...fields },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const opened = await call(base, `/api/gigs/${gigId}/live`, { method: "POST", token: orgToken, body: {} });
  assert.equal(opened.status, 200);
  const pass = await call(base, `/api/gigs/${gigId}/scanner`, { method: "POST", token: orgToken, body: {} });
  const receiver = await call(base, "/api/receiver/login", { method: "POST", body: { code: pass.data.code } });
  assert.equal(receiver.status, 200);
  return { gigId, receiver: receiver.data.token };
}

async function scanIn(base, fanToken, receiverToken) {
  const minted = await call(base, "/api/fan/checkin", { method: "POST", token: fanToken, body: {} });
  assert.equal(minted.status, 200, JSON.stringify(minted.data));
  const scanned = await call(base, "/api/receiver/scan", { method: "POST", token: receiverToken, body: { code: minted.data.code } });
  assert.equal(scanned.status, 200, JSON.stringify(scanned.data));
}

test("a city send is people who were at your gig there or who came to you and live there", async () => {
  const started = await boot();
  try {
    const band = await org(started.url, { kind: "band", name: "Night Bus", email: "bus-place@example.com" });
    const traveller = await fan(started.url, { username: "lea", email: "lea@example.com", city: "London", phone: "07000111111" });
    const local = await fan(started.url, { username: "ned", email: "ned@example.com", city: "London", phone: "07000222222" });
    const { receiver } = await openDoor(started.url, band, { name: "Paris night", city: "Paris" });
    await scanIn(started.url, traveller, receiver);

    const hometownOnly = await call(started.url, "/api/codes", { method: "POST", token: band, body: { group: "place", place: "London", label: "London" } });
    assert.equal(hometownOnly.status, 200, JSON.stringify(hometownOnly.data));
    assert.equal(hometownOnly.data.count, 1);

    const both = await call(started.url, "/api/codes", {
      method: "POST",
      token: band,
      body: { label: "Tour cities", groups: [{ type: "places", names: ["Paris", "London"] }] },
    });
    assert.equal(both.status, 200, JSON.stringify(both.data));
    assert.equal(both.data.count, 1);
    const file = await fetch(`${started.url}/api/codes/${both.data.batch}`, { headers: { authorization: `Bearer ${band}` } });
    const text = await file.text();
    assert.match(text, /Fans from London/);
    assert.equal(text.includes("Fans from Paris"), false);

    const leftover = await call(started.url, "/api/fan/codes", { token: local });
    assert.equal(leftover.data.length, 0);
    const places = await call(started.url, "/api/places", { token: band });
    assert.equal(places.status, 200);
    assert.ok(places.data.cities.includes("Paris"));
    assert.ok(places.data.cities.includes("London"));
  } finally {
    await shutdown(started);
  }
});

test("a phone cannot switch fan accounts for six hours", async () => {
  const started = await boot();
  try {
    const deviceId = randomUUID();
    await fan(started.url, { username: "first", email: "first@example.com", phone: "07000333333", deviceId });
    const blocked = await call(started.url, "/api/fan/signup", {
      method: "POST",
      body: { username: "second", email: "second@example.com", phone: "07000444444", password: "Password1!", confirm: "Password1!", deviceId },
    });
    assert.equal(blocked.status, 403);
    const same = await call(started.url, "/api/fan/login", { method: "POST", body: { email: "first@example.com", password: "Password1!", deviceId } });
    assert.equal(same.status, 200);
  } finally {
    await shutdown(started);
  }
});

test("a scanner session expires", async () => {
  const previous = process.env.RECEIVER_MS;
  process.env.RECEIVER_MS = "2500";
  const started = await boot();
  try {
    const venue = await org(started.url, { kind: "venue", name: "The Room", email: "door@example.com" });
    const { receiver } = await openDoor(started.url, venue, { name: "Late night" });
    const early = await call(started.url, "/api/receiver/event", { token: receiver });
    assert.equal(early.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const late = await call(started.url, "/api/receiver/event", { token: receiver });
    assert.equal(late.status, 401);
  } finally {
    await shutdown(started);
    if (previous === undefined) delete process.env.RECEIVER_MS;
    else process.env.RECEIVER_MS = previous;
  }
});

test("a new device needs a phone code after email is confirmed", async () => {
  const started = await boot();
  try {
    const firstDevice = randomUUID();
    await fan(started.url, { username: "ada", email: "ada-otp@example.com", phone: "07000900011", deviceId: firstDevice });
    const nextDevice = randomUUID();
    const challenge = await call(started.url, "/api/fan/login", { method: "POST", body: { email: "ada-otp@example.com", password: "Password1!", deviceId: nextDevice } });
    assert.equal(challenge.status, 200, JSON.stringify(challenge.data));
    assert.equal(challenge.data.needsOtp, true);
    assert.equal(challenge.data.token, undefined);
    assert.ok(challenge.data.challengeId);
    const wrong = await call(started.url, "/api/fan/login/otp", { method: "POST", body: { challengeId: challenge.data.challengeId, code: "000000", deviceId: nextDevice } });
    assert.equal(wrong.status, 401);
    const pin = await mailPin(started.url, "07000900011");
    const otherPhone = await call(started.url, "/api/fan/login/otp", { method: "POST", body: { challengeId: challenge.data.challengeId, code: pin, deviceId: randomUUID() } });
    assert.equal(otherPhone.status, 400);
    const passed = await call(started.url, "/api/fan/login/otp", { method: "POST", body: { challengeId: challenge.data.challengeId, code: pin, deviceId: nextDevice } });
    assert.equal(passed.status, 200, JSON.stringify(passed.data));
    assert.ok(passed.data.token);
    const again = await call(started.url, "/api/fan/login", { method: "POST", body: { email: "ada-otp@example.com", password: "Password1!", deviceId: nextDevice } });
    assert.equal(again.status, 200, JSON.stringify(again.data));
    assert.ok(again.data.token);
    assert.equal(again.data.needsOtp, undefined);
  } finally {
    await shutdown(started);
  }
});

test("sign-in is limited to five tries in fifteen minutes", async () => {
  const started = await boot();
  try {
    const deviceId = randomUUID();
    await fan(started.url, { username: "rate", email: "rate@example.com", phone: "07000900022", deviceId });
    for (let index = 0; index < 4; index += 1) {
      const logged = await call(started.url, "/api/fan/login", { method: "POST", body: { email: "rate@example.com", password: "Password1!", deviceId } });
      assert.equal(logged.status, 200, JSON.stringify(logged.data));
    }
    const blocked = await call(started.url, "/api/fan/login", { method: "POST", body: { email: "rate@example.com", password: "Password1!", deviceId } });
    assert.equal(blocked.status, 429);
  } finally {
    await shutdown(started);
  }
});

test("an unused scanner code expires and ending check-in signs doors out", async () => {
  const previous = process.env.SCANNER_MS;
  process.env.SCANNER_MS = "2500";
  const started = await boot();
  try {
    const venue = await org(started.url, { kind: "venue", name: "The Room", email: "door-end@example.com" });
    const created = await call(started.url, "/api/gigs", { method: "POST", token: venue, body: {} });
    const gigId = created.data.id;
    const saved = await call(started.url, `/api/gigs/${gigId}`, {
      method: "PATCH",
      token: venue,
      body: { name: "Close night", date: "2026-11-02", time: "20:00", image: png },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    await call(started.url, `/api/gigs/${gigId}/live`, { method: "POST", token: venue, body: {} });
    const first = await call(started.url, `/api/gigs/${gigId}/scanner`, { method: "POST", token: venue, body: {} });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.ok(first.data.expiresAt);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const stale = await call(started.url, "/api/receiver/login", { method: "POST", body: { code: first.data.code } });
    assert.equal(stale.status, 401);

    const second = await call(started.url, `/api/gigs/${gigId}/scanner`, { method: "POST", token: venue, body: {} });
    const receiver = await call(started.url, "/api/receiver/login", { method: "POST", body: { code: second.data.code } });
    assert.equal(receiver.status, 200);
    const ended = await call(started.url, `/api/gigs/${gigId}/live`, { method: "DELETE", token: venue });
    assert.equal(ended.status, 200);
    assert.equal(ended.data.live, false);
    const closed = await call(started.url, "/api/receiver/event", { token: receiver.data.token });
    assert.equal(closed.status, 401);
    const leftover = await call(started.url, `/api/gigs/${gigId}/scanner`, { method: "POST", token: venue, body: {} });
    assert.equal(leftover.status, 409);
  } finally {
    await shutdown(started);
    if (previous === undefined) delete process.env.SCANNER_MS;
    else process.env.SCANNER_MS = previous;
  }
});
