import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "./db.js";
import { listen } from "./http.js";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function boot() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ticketid-"));
  const db = openDatabase(dataDir);
  const started = await listen(db, dataDir, 0);
  return { ...started, db, dataDir };
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
  const found = message.data.body.match(/code: ([A-Z0-9]+)/);
  assert.ok(found, message.data.body);
  return found[1];
}

async function fan(base, details) {
  await call(base, "/api/fan/signup", { method: "POST", body: { password: "Password1!", phone: "07000000000", ...details } });
  const code = await mailCode(base, details.email);
  const verified = await call(base, "/api/verify", { method: "POST", body: { actor: "fan", email: details.email, code } });
  assert.equal(verified.status, 200);
  const logged = await call(base, "/api/fan/login", { method: "POST", body: { email: details.email, password: "Password1!" } });
  assert.equal(logged.status, 200);
  return logged.data.token;
}

async function org(base, details) {
  await call(base, "/api/org/signup", { method: "POST", body: { password: "Password1!", ...details } });
  const code = await mailCode(base, details.email);
  await call(base, "/api/verify", { method: "POST", body: { actor: "org", email: details.email, code } });
  const logged = await call(base, "/api/org/login", { method: "POST", body: { email: details.email, password: "Password1!" } });
  assert.equal(logged.status, 200);
  await call(base, "/api/org/me", { method: "PATCH", token: logged.data.token, body: { profileImage: png } });
  return logged.data.token;
}

test("a fan confirms their email before they can sign in", async () => {
  const started = await boot();
  const signup = await call(started.url, "/api/fan/signup", { method: "POST", body: { username: "ada", email: "ada@example.com", phone: "07000900000", password: "Password1!" } });
  assert.equal(signup.status, 200);
  const early = await call(started.url, "/api/fan/login", { method: "POST", body: { email: "ada@example.com", password: "Password1!" } });
  assert.equal(early.status, 403);
  const code = await mailCode(started.url, "ada@example.com");
  const verified = await call(started.url, "/api/verify", { method: "POST", body: { actor: "fan", email: "ada@example.com", code } });
  assert.equal(verified.data.actor, "fan");
  const logged = await call(started.url, "/api/fan/login", { method: "POST", body: { email: "ada@example.com", password: "Password1!" } });
  assert.equal(logged.status, 200);
  started.server.close();
  started.db.close();
  await rm(started.dataDir, { recursive: true, force: true });
});

test("a scan proves a fan and a priority code reaches only that account", async () => {
  const previous = process.env.CHECKIN_MS;
  process.env.CHECKIN_MS = "250";
  const started = await boot();
  const venue = await org(started.url, { kind: "venue", name: "The Room", email: "room@example.com" });
  const band = await org(started.url, { kind: "band", name: "Night Bus", email: "bus@example.com" });
  const stranger = await org(started.url, { kind: "band", name: "Other", email: "other@example.com" });
  const fanToken = await fan(started.url, { username: "mina", email: "mina@example.com", hometown: "Hackney", city: "London" });
  const opted = await fan(started.url, { username: "otto", email: "otto@example.com", city: "London" });
  await call(started.url, "/api/fan/me", { method: "PATCH", token: opted, body: { registeredOnly: true } });

  const created = await call(started.url, "/api/gigs", { method: "POST", token: venue, body: {} });
  const gigId = created.data.id;
  const bandCode = await call(started.url, "/api/org/join-code", { method: "POST", token: band, body: {} });
  const added = await call(started.url, `/api/gigs/${gigId}/acts`, { method: "POST", token: venue, body: { code: bandCode.data.code } });
  assert.equal(added.status, 200);
  const again = await call(started.url, `/api/gigs/${gigId}/acts`, { method: "POST", token: venue, body: { code: bandCode.data.code } });
  assert.equal(again.status, 400);
  const saved = await call(started.url, `/api/gigs/${gigId}`, {
    method: "PATCH",
    token: venue,
    body: { name: "Night Bus at The Room", date: "2026-11-02", time: "20:00", bio: "A Monday.", image: png, tourName: "Autumn" },
  });
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
  const receiver = await call(started.url, "/api/receiver/login", { method: "POST", body: { code: pass.data.code } });
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

  const expiredMint = await call(started.url, "/api/fan/checkin", { method: "POST", token: opted, body: {} });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const expired = await call(started.url, "/api/receiver/scan", { method: "POST", token: receiver.data.token, body: { code: expiredMint.data.code } });
  assert.equal(expired.status, 400);

  const denied = await call(started.url, "/api/codes", { method: "POST", token: stranger, body: { group: "gig", gigId, label: "Priority" } });
  assert.equal(denied.status, 403);
  const sent = await call(started.url, "/api/codes", { method: "POST", token: band, body: { group: "gig", gigId, label: "Priority access" } });
  assert.equal(sent.data.count, 1);
  const codes = await call(started.url, "/api/fan/codes", { token: fanToken });
  assert.equal(codes.data.length, 1);
  assert.equal(codes.data[0].label, "Priority access");
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

  started.server.close();
  started.db.close();
  await rm(started.dataDir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.CHECKIN_MS;
  else process.env.CHECKIN_MS = previous;
});

test("a fan changes a password and can recover it by email or phone", async () => {
  const started = await boot();
  const token = await fan(started.url, { username: "ada", email: "ada@example.com", phone: "07000900000" });
  const weak = await call(started.url, "/api/fan/password", { method: "POST", token, body: { currentPassword: "Password1!", password: "password1", confirm: "password1" } });
  assert.equal(weak.status, 400);
  const wrong = await call(started.url, "/api/fan/password", { method: "POST", token, body: { currentPassword: "nope", password: "Password2!", confirm: "Password2!" } });
  assert.equal(wrong.status, 401);
  const mismatch = await call(started.url, "/api/fan/password", { method: "POST", token, body: { currentPassword: "Password1!", password: "Password2!", confirm: "Password3!" } });
  assert.equal(mismatch.status, 400);
  const changed = await call(started.url, "/api/fan/password", { method: "POST", token, body: { currentPassword: "Password1!", password: "Password2!", confirm: "Password2!" } });
  assert.equal(changed.status, 200);
  const logged = await call(started.url, "/api/fan/login", { method: "POST", body: { email: "ada@example.com", password: "Password2!" } });
  assert.equal(logged.status, 200);

  const missing = await call(started.url, "/api/fan/recover", { method: "POST", body: { contact: "nobody@example.com" } });
  assert.equal(missing.status, 404);
  const sent = await call(started.url, "/api/fan/recover", { method: "POST", body: { contact: "07000900000" } });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.email, "ada@example.com");
  const code = await mailCode(started.url, "ada@example.com");
  const reset = await call(started.url, "/api/fan/recover/confirm", { method: "POST", body: { email: sent.data.email, code, password: "Password3!", confirm: "Password3!" } });
  assert.equal(reset.status, 200);
  const again = await call(started.url, "/api/fan/login", { method: "POST", body: { email: "ada@example.com", password: "Password3!" } });
  assert.equal(again.status, 200);

  const saved = await call(started.url, "/api/fan/me", { method: "PATCH", token: again.data.token, body: { city: "London", country: "United Kingdom", email: "ada@example.com" } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.city, "London");
  assert.equal(saved.data.country, "United Kingdom");
  assert.equal(saved.data.email, "ada@example.com");
  assert.equal(saved.data.hometown, undefined);

  started.server.close();
  started.db.close();
  await rm(started.dataDir, { recursive: true, force: true });
});
