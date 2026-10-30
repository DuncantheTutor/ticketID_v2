const { createHash, randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const express = require("express");
const admin = require("firebase-admin");
const QRCode = require("qrcode");

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SENT = Symbol("sent");
const collections = [
  "fans",
  "usernames",
  "orgs",
  "gigs",
  "registrations",
  "checkins",
  "checkinHashes",
  "scannerCodes",
  "joinCodes",
  "priorityCodes",
  "priorityCodeValues",
  "passwordResets",
  "mail",
  "deviceTokens",
  "deviceBinds",
  "receiverSessions",
];

let db;
let bucket;

function initAdmin() {
  if (admin.apps.length) return;
  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "demo-ticketid";
  admin.initializeApp({
    projectId,
    storageBucket: process.env.STORAGE_BUCKET || `${projectId}.appspot.com`,
  });
}

function services() {
  initAdmin();
  if (!db) {
    db = admin.firestore();
    db.settings({ ignoreUndefinedProperties: true });
    bucket = admin.storage().bucket();
  }
  return { db, bucket };
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function code(length) {
  const bytes = randomBytes(length);
  let out = "";
  for (let index = 0; index < length; index += 1) out += alphabet[bytes[index] % alphabet.length];
  return out;
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function placeNeedle(value) {
  return String(value ?? "").trim().toLowerCase();
}

function deviceLockMs() {
  const value = Number(process.env.DEVICE_LOCK_MS || 6 * 60 * 60 * 1000);
  return Number.isFinite(value) && value > 0 ? value : 6 * 60 * 60 * 1000;
}

function receiverTtlMs() {
  const value = Number(process.env.RECEIVER_MS || 24 * 60 * 60 * 1000);
  return Number.isFinite(value) && value > 0 ? value : 24 * 60 * 60 * 1000;
}

function checkinTtlMs() {
  const value = Number(process.env.CHECKIN_MS || 30_000);
  return Number.isFinite(value) && value > 0 ? value : 30_000;
}

function appCheckEnabled() {
  if (usingEmulator()) return false;
  const flag = String(process.env.APP_CHECK_ENFORCE || "").trim().toLowerCase();
  return flag === "true" || flag === "1" || flag === "yes";
}

async function requireAppCheck(request) {
  if (!appCheckEnabled()) return;
  const header = String(request.headers["x-firebase-appcheck"] || request.headers["x-firebase-appcheck-token"] || "").trim();
  if (!header) throw fail(401, "This app could not be verified.");
  try {
    await admin.appCheck().verifyToken(header);
  } catch {
    throw fail(401, "This app could not be verified.");
  }
}

function deviceKey(value) {
  const id = String(value ?? "").trim();
  if (id.length < 8 || id.length > 128) throw fail(400, "That phone could not be verified.");
  return sha(id);
}

function fanHomePlace(fan, place) {
  return (fan.placeKeys || []).includes(place);
}

function gigInPlace(gig, place) {
  return placeNeedle(gig.city) === place || placeNeedle(gig.country) === place;
}

function preferPlace(fan, matches) {
  const rows = (matches || []).map((item) => ({ place: placeNeedle(item.place), via: item.via, label: item.place }));
  const homeCity = placeNeedle(fan.city);
  const homeCountry = placeNeedle(fan.country);
  const home = rows.find((item) => item.place && (item.place === homeCity || item.place === homeCountry || item.via === "home"));
  if (home) return home;
  return rows[0] || { place: "", label: "" };
}

function cleanEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function optionalPlace(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function phoneKey(value) {
  return String(value ?? "").replace(/\D/g, "").replace(/^0+/, "").replace(/^44/, "");
}

function placeKeys(city, country) {
  return [...new Set([city, country].map((value) => String(value ?? "").trim().toLowerCase()).filter(Boolean))];
}

function assertPassword(password) {
  const value = String(password ?? "");
  if (value.length < 8 || !/[A-Z]/.test(value) || !/[0-9]/.test(value) || !/[^A-Za-z0-9]/.test(value)) {
    throw fail(400, "Use at least 8 characters, with one capital letter, one number, and one special character.");
  }
}

function samePassword(password, confirm) {
  if (password !== String(confirm ?? "")) throw fail(400, "Enter the same password twice.");
}

function sameCode(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function docData(snap) {
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function getDoc(name, id) {
  if (!id) return null;
  return docData(await db.collection(name).doc(String(id)).get());
}

async function deleteDocs(docs) {
  for (let index = 0; index < docs.length; index += 400) {
    const batch = db.batch();
    docs.slice(index, index + 400).forEach((item) => batch.delete(item.ref));
    await batch.commit();
  }
}

async function deleteWhere(name, field, value) {
  const snap = await db.collection(name).where(field, "==", value).get();
  await deleteDocs(snap.docs);
}

async function clearCollection(name) {
  const snap = await db.collection(name).limit(400).get();
  if (snap.empty) return;
  await deleteDocs(snap.docs);
  if (snap.size === 400) await clearCollection(name);
}

function usingEmulator() {
  return Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FUNCTIONS_EMULATOR);
}

function apiKey() {
  return process.env.TICKETID_WEB_API_KEY || process.env.FIREBASE_WEB_API_KEY || "demo";
}

function hasApiKey() {
  return Boolean(process.env.TICKETID_WEB_API_KEY || process.env.FIREBASE_WEB_API_KEY);
}

async function identity(pathname, body) {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const url = host
    ? `http://${host}/identitytoolkit.googleapis.com/v1/${pathname}?key=${apiKey()}`
    : `https://identitytoolkit.googleapis.com/v1/${pathname}?key=${apiKey()}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = String(data.error?.message || "AUTH_FAILED").split(" : ")[0];
    const error = fail(response.status || 400, message);
    error.code = message;
    throw error;
  }
  return data;
}

async function signInWithPassword(email, password) {
  try {
    const session = await identity("accounts:signInWithPassword", { email, password, returnSecureToken: true });
    return { idToken: session.idToken, refreshToken: session.refreshToken };
  } catch (error) {
    if (["EMAIL_NOT_FOUND", "INVALID_PASSWORD", "INVALID_LOGIN_CREDENTIALS", "USER_DISABLED"].includes(error.code)) {
      throw fail(401, "That email or password is wrong.");
    }
    throw error;
  }
}

async function exchangeRefresh(refreshToken) {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const key = apiKey();
  const url = host
    ? `http://${host}/securetoken.googleapis.com/v1/token?key=${key}`
    : `https://securetoken.googleapis.com/v1/token?key=${key}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id_token) throw fail(401, "Sign in to continue.");
  return { token: data.id_token, refreshToken: data.refresh_token };
}

function sessionBody(session, extra = {}) {
  return { token: session.idToken, refreshToken: session.refreshToken, ...extra };
}

async function sessionWithActor(session, actor, message) {
  let current = session;
  let decoded = await verifyToken(current.idToken);
  if (decoded.actor !== actor) {
    const refreshed = await exchangeRefresh(current.refreshToken);
    current = { idToken: refreshed.token, refreshToken: refreshed.refreshToken };
    decoded = await verifyToken(current.idToken);
  }
  if (decoded.actor !== actor) throw fail(401, message);
  return current;
}

async function verifyToken(token) {
  if (!token) throw fail(401, "Sign in to continue.");
  try {
    return await admin.auth().verifyIdToken(token, true);
  } catch {
    throw fail(401, "Sign in to continue.");
  }
}

function bearer(request) {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function routePath(request) {
  const value = request.path || "/";
  const api = value.indexOf("/api/");
  if (api > 0) return value.slice(api);
  const media = value.indexOf("/media/");
  if (media > 0) return value.slice(media);
  return value;
}

function publicFan(fan) {
  return {
    id: fan.id,
    username: fan.username,
    email: fan.email,
    phone: fan.phone,
    city: fan.city || null,
    country: fan.country || null,
    registeredOnly: fan.registeredOnly === true,
  };
}

function publicOrg(org) {
  return {
    id: org.id,
    kind: org.kind,
    name: org.name,
    email: org.email,
    profileImage: org.profileImage ? `/media/${org.profileImage}` : null,
  };
}

function gigReady(gig) {
  return Boolean(gig?.name && gig?.image && gig?.startsAt);
}

function membersOf(gig) {
  return Object.entries(gig.members || {}).map(([id, member]) => ({
    id,
    kind: member.kind,
    name: member.name,
    role: member.role,
    profileImage: member.profileImage ? `/media/${member.profileImage}` : null,
  })).sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function gigView(gig, orgId) {
  return {
    id: gig.id,
    name: gig.name,
    startsAt: gig.startsAt || null,
    bio: gig.bio || "",
    tourName: gig.tourName || null,
    city: gig.city || "",
    country: gig.country || "",
    image: gig.image ? `/media/${gig.image}` : null,
    ready: gigReady(gig),
    live: gig.live === true,
    members: membersOf(gig),
    owner: gig.creatorOrgId === orgId,
  };
}

function orgRole(kind) {
  if (["band", "team", "ensemble"].includes(kind)) return "act";
  if (kind === "venue") return "venue";
  if (kind === "festival") return "festival";
  return "organiser";
}

function scannerQr(value) {
  return QRCode.toDataURL(`ticketid:${value}`, {
    errorCorrectionLevel: "M",
    margin: 4,
    width: 360,
    color: { dark: "#000000", light: "#ffffff" },
  });
}

function imageKind(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return "png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
  return "";
}

function imageType(kind) {
  if (kind === "png") return "image/png";
  if (kind === "webp") return "image/webp";
  if (kind === "jpeg") return "image/jpeg";
  return "";
}

async function saveImage(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl ?? ""));
  if (!match) throw fail(400, "Use a PNG, JPEG, or WebP image.");
  const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!buffer.length || buffer.length > 1_500_000) throw fail(400, "Use an image under 1.5 MB.");
  const declared = match[1].toLowerCase().includes("png") ? "png" : match[1].toLowerCase().includes("webp") ? "webp" : "jpeg";
  const kind = imageKind(buffer);
  if (!kind || kind !== declared) throw fail(400, "Use a PNG, JPEG, or WebP image.");
  const ext = kind === "jpeg" ? "jpg" : kind;
  const filename = `${randomUUID()}.${ext}`;
  await bucket.file(`images/${filename}`).save(buffer, { contentType: imageType(kind), resumable: false });
  return filename;
}

async function sendMedia(response, name) {
  if (!/^[\w.-]+$/.test(name)) throw fail(404, "That image was not found.");
  const file = bucket.file(`images/${name}`);
  const [exists] = await file.exists();
  if (!exists) throw fail(404, "That image was not found.");
  const [buffer] = await file.download();
  const ext = name.split(".").pop();
  const expected = ext === "png" ? "png" : ext === "webp" ? "webp" : ext === "jpg" || ext === "jpeg" ? "jpeg" : "";
  const kind = imageKind(buffer);
  if (!expected || kind !== expected) throw fail(404, "That image was not found.");
  response.status(200).set("content-type", imageType(kind)).set("cache-control", "public, max-age=86400").set("x-content-type-options", "nosniff").send(buffer);
  return SENT;
}

async function reserveUsername(uid, username, previousLower) {
  const name = username.toLowerCase();
  await db.runTransaction(async (tx) => {
    const ref = db.collection("usernames").doc(name);
    const snap = await tx.get(ref);
    if (snap.exists && snap.data().uid !== uid) throw fail(400, "That username is taken.");
    if (previousLower && previousLower !== name) tx.delete(db.collection("usernames").doc(previousLower));
    tx.set(ref, { uid });
  });
}

async function rollbackAccount(uid, username) {
  if (username) {
    const ref = db.collection("usernames").doc(username.toLowerCase());
    const snap = await ref.get();
    if (snap.exists && snap.data().uid === uid) await ref.delete();
  }
  await db.collection("fans").doc(uid).delete().catch(() => undefined);
  await db.collection("orgs").doc(uid).delete().catch(() => undefined);
  await admin.auth().deleteUser(uid).catch(() => undefined);
}

async function createAuthUser(email, password) {
  try {
    return await admin.auth().createUser({ email, password });
  } catch (error) {
    if (error.code === "auth/email-already-exists") throw fail(400, "That email is already registered.");
    throw error;
  }
}

async function assertFanDevice(deviceId, fanId) {
  const key = deviceKey(deviceId);
  const ref = db.collection("deviceBinds").doc(key);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const seen = new Date(now).toISOString();
    if (snap.exists) {
      const row = snap.data();
      if (row.fanId === fanId) {
        tx.set(ref, { fanId, lastSeenAt: seen, boundAt: row.boundAt || seen }, { merge: true });
        return;
      }
      const last = new Date(row.lastSeenAt || row.boundAt || 0).getTime();
      if (Number.isFinite(last) && now < last + deviceLockMs()) {
        throw fail(403, "This phone is already signed in to another account. You can use that account again, or wait before using a different one.");
      }
    }
    tx.set(ref, { fanId, lastSeenAt: seen, boundAt: seen });
  });
}

async function signupFan(body) {
  const username = String(body.username ?? "").trim();
  const email = cleanEmail(body.email);
  const phone = String(body.phone ?? "").trim();
  const password = String(body.password ?? "");
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw fail(400, "Use a username of 3 to 20 letters, numbers, or underscores.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, "Enter a valid email address.");
  if (phoneKey(phone).length < 8) throw fail(400, "Enter a phone number.");
  samePassword(password, body.confirm);
  assertPassword(password);
  deviceKey(body.deviceId);
  const city = optionalPlace(body.city ?? body.hometown);
  const country = optionalPlace(body.country);
  const user = await createAuthUser(email, password);
  try {
    await reserveUsername(user.uid, username);
    await db.collection("fans").doc(user.uid).set({
      username,
      usernameLower: username.toLowerCase(),
      email,
      phone,
      phoneKey: phoneKey(phone),
      city,
      country,
      placeKeys: placeKeys(city, country),
      registeredOnly: false,
      createdAt: new Date().toISOString(),
    });
    await admin.auth().setCustomUserClaims(user.uid, { actor: "fan" });
    await assertFanDevice(body.deviceId, user.uid);
  } catch (error) {
    await rollbackAccount(user.uid, username);
    throw error;
  }
  return sessionBody(await sessionWithActor(await signInWithPassword(email, password), "fan", "Sign in to continue."), { email });
}

async function signupOrg(body) {
  const kind = String(body.kind ?? "");
  const name = String(body.name ?? "").trim();
  const email = cleanEmail(body.email);
  const password = String(body.password ?? "");
  if (!["band", "team", "ensemble", "organiser", "venue", "festival"].includes(kind)) throw fail(400, "Choose what kind of account this is.");
  if (!name) throw fail(400, "Enter a name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, "Enter a valid email address.");
  samePassword(password, body.confirm);
  assertPassword(password);
  const user = await createAuthUser(email, password);
  try {
    await db.collection("orgs").doc(user.uid).set({
      kind,
      name,
      email,
      profileImage: null,
      createdAt: new Date().toISOString(),
    });
    await admin.auth().setCustomUserClaims(user.uid, { actor: "org" });
  } catch (error) {
    await rollbackAccount(user.uid);
    throw error;
  }
  return sessionBody(await sessionWithActor(await signInWithPassword(email, password), "org", "Sign in to continue."), { email });
}

async function loginAccount(body, actor) {
  const email = cleanEmail(body.email);
  const session = await sessionWithActor(await signInWithPassword(email, String(body.password ?? "")), actor, "That email or password is wrong.");
  const decoded = await verifyToken(session.idToken);
  const record = await getDoc(actor === "fan" ? "fans" : "orgs", decoded.uid);
  if (!record) throw fail(401, "That email or password is wrong.");
  if (actor === "fan") await assertFanDevice(body.deviceId, decoded.uid);
  return sessionBody(session);
}

async function endReceiver(uid) {
  await admin.auth().revokeRefreshTokens(uid).catch(() => undefined);
  await admin.auth().deleteUser(uid).catch(() => undefined);
  await db.collection("receiverSessions").doc(uid).delete().catch(() => undefined);
}

async function logout(token) {
  if (!token) return { ok: true };
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    if (decoded.actor === "receiver") {
      await endReceiver(decoded.uid);
    } else {
      await admin.auth().revokeRefreshTokens(decoded.uid);
      const snap = await db.collection("deviceTokens").where("fanId", "==", decoded.uid).get();
      await deleteDocs(snap.docs);
    }
  } catch {
    /* the session was already finished */
  }
  return { ok: true };
}

async function requireFan(token) {
  const decoded = await verifyToken(token);
  if (decoded.actor !== "fan") throw fail(401, "Sign in to continue.");
  const fan = await getDoc("fans", decoded.uid);
  if (!fan) throw fail(401, "Sign in to continue.");
  return fan;
}

async function requireOrg(token) {
  const decoded = await verifyToken(token);
  if (decoded.actor !== "org") throw fail(401, "Sign in to continue.");
  const org = await getDoc("orgs", decoded.uid);
  if (!org) throw fail(401, "Sign in to continue.");
  return org;
}

async function requireReceiver(token) {
  const decoded = await verifyToken(token);
  if (decoded.actor !== "receiver" || !decoded.gigId) throw fail(401, "Sign in to continue.");
  const session = await getDoc("receiverSessions", decoded.uid);
  if (!session || session.gigId !== decoded.gigId) throw fail(401, "Sign in to the event again.");
  if (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now()) {
    await endReceiver(decoded.uid);
    throw fail(401, "This scanner has expired. Generate a new scanner code.");
  }
  const gig = await getDoc("gigs", decoded.gigId);
  if (!gig || !gig.image) throw fail(401, "Sign in to the event again.");
  if (gig.live !== true) throw fail(401, "This event is not live.");
  return gig;
}

async function fanByContact(contact) {
  const text = String(contact ?? "").trim();
  if (!text) return null;
  if (text.includes("@")) {
    const snap = await db.collection("fans").where("email", "==", cleanEmail(text)).limit(1).get();
    return snap.empty ? null : docData(snap.docs[0]);
  }
  const key = phoneKey(text);
  if (key.length < 8) return null;
  const snap = await db.collection("fans").where("phoneKey", "==", key).limit(1).get();
  return snap.empty ? null : docData(snap.docs[0]);
}

async function requireCurrentPassword(email, password) {
  const value = String(password ?? "");
  if (!value) throw fail(401, "That password is wrong.");
  try {
    await signInWithPassword(email, value);
  } catch (error) {
    if (error.status === 401) throw fail(401, "That password is wrong.");
    throw error;
  }
}

async function updateFan(token, body) {
  const fan = await requireFan(token);
  await requireCurrentPassword(fan.email, body.currentPassword);
  const username = body.username === undefined ? fan.username : String(body.username).trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw fail(400, "Use a username of 3 to 20 letters, numbers, or underscores.");
  const phone = body.phone === undefined ? fan.phone : String(body.phone).trim();
  if (phoneKey(phone).length < 8) throw fail(400, "Enter a phone number.");
  let email = fan.email;
  if (body.email !== undefined) {
    email = cleanEmail(body.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, "Enter a valid email address.");
    const taken = await db.collection("fans").where("email", "==", email).limit(1).get();
    if (!taken.empty && taken.docs[0].id !== fan.id) throw fail(400, "That email is already registered.");
  }
  const city = body.city !== undefined ? optionalPlace(body.city) : body.hometown !== undefined ? optionalPlace(body.hometown) : fan.city;
  const country = body.country === undefined ? fan.country : optionalPlace(body.country);
  const registeredOnly = body.registeredOnly === undefined ? fan.registeredOnly === true : Boolean(body.registeredOnly);
  if (username.toLowerCase() !== fan.usernameLower) await reserveUsername(fan.id, username, fan.usernameLower);
  if (email !== fan.email) {
    try {
      await admin.auth().updateUser(fan.id, { email });
    } catch (error) {
      if (error.code === "auth/email-already-exists") throw fail(400, "That email is already registered.");
      throw error;
    }
  }
  await db.collection("fans").doc(fan.id).update({
    username,
    usernameLower: username.toLowerCase(),
    email,
    phone,
    phoneKey: phoneKey(phone),
    city,
    country,
    placeKeys: placeKeys(city, country),
    registeredOnly,
  });
  return publicFan(await getDoc("fans", fan.id));
}

async function changeFanPassword(token, body) {
  const fan = await requireFan(token);
  const password = String(body.password ?? "");
  samePassword(password, body.confirm);
  assertPassword(password);
  await requireCurrentPassword(fan.email, body.currentPassword);
  await admin.auth().updateUser(fan.id, { password });
  await admin.auth().revokeRefreshTokens(fan.id);
  return { ok: true, ...sessionBody(await sessionWithActor(await signInWithPassword(fan.email, password), "fan", "Sign in to continue.")) };
}

async function rememberMail(email, subject, body) {
  if (!usingEmulator()) return;
  await db.collection("mail").add({ email, subject, body, createdAt: new Date().toISOString() });
}

async function clearFanMail(email) {
  await deleteWhere("mail", "email", cleanEmail(email));
}

function publicOrigin() {
  const configured = String(process.env.TICKETID_PUBLIC_URL || "").trim().replace(/\/$/, "");
  if (configured) return configured;
  if (usingEmulator()) return "http://127.0.0.1:5050";
  return "https://ticketid-ab43c.web.app";
}

let resetHandlerReady = false;

async function pointResetEmailAtApp() {
  if (resetHandlerReady || usingEmulator()) return;
  try {
    const credential = admin.app().options.credential;
    if (!credential || typeof credential.getAccessToken !== "function") return;
    const access = await credential.getAccessToken();
    const token = access.access_token || access.accessToken;
    if (!token) return;
    const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || admin.app().options.projectId || "ticketid-ab43c";
    const response = await fetch(`https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/config?updateMask=notification.sendEmail.callbackUri`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ notification: { sendEmail: { callbackUri: `${publicOrigin()}/reset` } } }),
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) resetHandlerReady = true;
  } catch {
    /* The reset email still sends. The link target stays on the current project setting. */
  }
}

async function appResetLink(email) {
  let link = "";
  try {
    link = await admin.auth().generatePasswordResetLink(email, { url: `${publicOrigin()}/` });
  } catch {
    throw fail(503, "Password reset email is not set up yet.");
  }
  let oobCode = "";
  try {
    oobCode = new URL(link).searchParams.get("oobCode") || "";
  } catch {
    oobCode = "";
  }
  if (!oobCode) throw fail(503, "Password reset email is not set up yet.");
  return `${publicOrigin()}/reset?oobCode=${encodeURIComponent(oobCode)}`;
}

async function recoverFan(body) {
  const contact = String(body.contact ?? "").trim();
  if (!contact) throw fail(400, "Enter the email or phone number on the account.");
  if (!usingEmulator() && !hasApiKey()) throw fail(503, "Password reset email is not set up yet.");
  const fan = await fanByContact(contact);
  if (fan) {
    if (fan.resetId) await db.collection("passwordResets").doc(fan.resetId).delete().catch(() => undefined);
    await db.collection("fans").doc(fan.id).update({ resetId: null });
    await clearFanMail(fan.email);
    if (usingEmulator()) {
      const appLink = await appResetLink(fan.email);
      await rememberMail(fan.email, "Reset your password", `Reset your password for ticketID.\n\n${appLink}\n`);
    } else {
      await pointResetEmailAtApp();
      await identity("accounts:sendOobCode", {
        requestType: "PASSWORD_RESET",
        email: fan.email,
        continueUrl: `${publicOrigin()}/`,
      });
    }
  }
  return { ok: true };
}

async function confirmFanRecovery(body) {
  const password = String(body.password ?? "");
  samePassword(password, body.confirm);
  assertPassword(password);
  const oobCode = String(body.oobCode ?? "").trim();
  if (!oobCode) throw fail(400, "That link has expired. Send a new one.");
  let email = "";
  try {
    const result = await identity("accounts:resetPassword", { oobCode, newPassword: password });
    email = cleanEmail(result.email);
  } catch {
    throw fail(400, "That link has expired. Send a new one.");
  }
  const found = await db.collection("fans").where("email", "==", email).limit(1).get();
  if (!found.empty) {
    const fan = docData(found.docs[0]);
    await admin.auth().revokeRefreshTokens(fan.id);
    if (fan.resetId) await db.collection("passwordResets").doc(fan.resetId).delete().catch(() => undefined);
    await db.collection("fans").doc(fan.id).update({ resetId: null });
    await clearFanMail(email);
  }
  return { ok: true };
}

async function mintCheckin(token) {
  const fan = await requireFan(token);
  const ttl = checkinTtlMs();
  const raw = code(10);
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + ttl).toISOString();
  if (fan.activeCheckinId) {
    await db.collection("checkins").doc(fan.activeCheckinId).set({ usedAt: new Date().toISOString() }, { merge: true });
  }
  await db.collection("checkins").doc(id).set({ fanId: fan.id, codeHash: sha(raw), expiresAt, usedAt: null, gigId: null });
  await db.collection("checkinHashes").doc(sha(raw)).set({ id });
  await db.collection("fans").doc(fan.id).update({ activeCheckinId: id });
  const qr = await QRCode.toDataURL(raw, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 280,
    color: { dark: "#102e32", light: "#f3f1ea" },
  });
  return { id, code: raw, expiresAt, qr };
}

async function checkinStatus(token, id) {
  const fan = await requireFan(token);
  const row = await getDoc("checkins", id);
  if (!row || row.fanId !== fan.id) throw fail(404, "That code was not found.");
  if (row.usedAt && row.gigId) {
    const gig = await getDoc("gigs", row.gigId);
    return { status: "registered", gigName: gig?.name ?? "", image: gig?.image ? `/media/${gig.image}` : null, startsAt: gig?.startsAt ?? null };
  }
  if (new Date(row.expiresAt).getTime() < Date.now()) return { status: "expired" };
  return { status: "pending" };
}

async function fanGigs(token) {
  const fan = await requireFan(token);
  const snap = await db.collection("registrations").where("fanId", "==", fan.id).get();
  const rows = [];
  for (const item of snap.docs) {
    const gig = await getDoc("gigs", item.data().gigId);
    if (!gig) continue;
    rows.push({
      id: gig.id,
      name: gig.name,
      startsAt: gig.startsAt || null,
      bio: gig.bio || "",
      tourName: gig.tourName || "",
      image: gig.image ? `/media/${gig.image}` : null,
      registeredAt: item.data().registeredAt,
      members: membersOf(gig),
    });
  }
  rows.sort((left, right) => String(right.startsAt || "").localeCompare(String(left.startsAt || "")));
  return rows;
}

async function fanCodes(token) {
  const fan = await requireFan(token);
  const snap = await db.collection("priorityCodes").where("fanId", "==", fan.id).get();
  const now = new Date().toISOString();
  const orgs = new Map();
  const codes = [];
  const rows = snap.docs.map((item) => ({ id: item.id, ...item.data() }))
    .filter((row) => !row.expiresAt || row.expiresAt > now)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  for (const row of rows) {
    if (!orgs.has(row.orgId)) orgs.set(row.orgId, await getDoc("orgs", row.orgId));
    const org = orgs.get(row.orgId);
    const inPerson = row.inPerson === true;
    const tile = row.image ? `/media/${row.image}` : (org?.profileImage ? `/media/${org.profileImage}` : null);
    codes.push({
      id: row.id,
      label: row.label,
      message: row.message || "",
      expiresAt: row.expiresAt || null,
      code: row.code,
      inPerson,
      qr: inPerson ? await QRCode.toDataURL(row.code, {
        errorCorrectionLevel: "M",
        margin: 0,
        width: 280,
        color: { dark: "#102e32", light: "#f3f1ea" },
      }) : null,
      createdAt: row.createdAt,
      orgName: org?.name || "",
      orgKind: org?.kind || "",
      profileImage: tile,
    });
  }
  return codes;
}

async function refreshMember(org) {
  const snap = await db.collection("gigs").where("memberIds", "array-contains", org.id).get();
  for (const item of snap.docs) {
    const members = { ...(item.data().members || {}) };
    if (!members[org.id]) continue;
    members[org.id] = { ...members[org.id], kind: org.kind, name: org.name, profileImage: org.profileImage || null };
    await item.ref.update({ members });
  }
}

async function updateOrg(token, body) {
  const org = await requireOrg(token);
  await requireCurrentPassword(org.email, body.currentPassword);
  const name = body.name === undefined ? org.name : String(body.name).trim();
  if (!name) throw fail(400, "Enter a name.");
  const kinds = ["band", "team", "ensemble", "organiser", "venue", "festival"];
  const kind = body.kind === undefined ? org.kind : String(body.kind);
  if (!kinds.includes(kind)) throw fail(400, "Choose what kind of account this is.");
  let image = org.profileImage || null;
  if (body.profileImage) image = await saveImage(body.profileImage);
  await db.collection("orgs").doc(org.id).update({ name, kind, profileImage: image });
  const saved = await getDoc("orgs", org.id);
  await refreshMember(saved);
  return publicOrg(saved);
}

async function newJoinCode(token) {
  const org = await requireOrg(token);
  if (org.joinCode) await db.collection("joinCodes").doc(org.joinCode).delete().catch(() => undefined);
  let join = code(6);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await db.collection("joinCodes").doc(join).create({ orgId: org.id, usedAt: null, expiresAt: new Date(Date.now() + 45_000).toISOString() });
      break;
    } catch (error) {
      join = code(6);
      if (attempt === 4) throw error;
    }
  }
  const expiresAt = (await getDoc("joinCodes", join)).expiresAt;
  await db.collection("orgs").doc(org.id).update({ joinCode: join, joinExpiresAt: expiresAt });
  return { code: join, expiresAt };
}

async function gigsForOrg(orgId) {
  const snap = await db.collection("gigs").where("memberIds", "array-contains", orgId).get();
  return snap.docs.map((item) => docData(item));
}

async function listGigs(token) {
  const org = await requireOrg(token);
  const rows = await gigsForOrg(org.id);
  rows.sort((left, right) => String(right.startsAt || right.createdAt || "").localeCompare(String(left.startsAt || left.createdAt || "")));
  return rows.map((gig) => gigView(gig, org.id));
}

function eventStart(dateValue, timeValue) {
  const date = String(dateValue ?? "").trim();
  const time = String(timeValue ?? "").trim() || "00:00";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail(400, "Enter the date of the event.");
  if (!/^\d{2}:\d{2}$/.test(time)) throw fail(400, "Enter a valid time.");
  return `${date}T${time}`;
}

async function assertOnGig(orgId, gigId) {
  const gig = await getDoc("gigs", gigId);
  if (!gig) throw fail(404, "That event was not found.");
  if (!gig.memberIds?.includes(orgId)) throw fail(403, "That event belongs to someone else.");
  return gig;
}

function assertCreator(orgId, gig) {
  if (gig.creatorOrgId !== orgId) throw fail(403, "Only the account that created this event can change it.");
  return gig;
}

async function createGig(token, body = {}) {
  const org = await requireOrg(token);
  const id = randomUUID();
  const role = orgRole(org.kind);
  let image = null;
  if (body.image) image = await saveImage(body.image);
  else if (body.copyFrom) image = (await assertOnGig(org.id, String(body.copyFrom))).image || null;
  const name = String(body.name ?? "").trim() || null;
  const bio = String(body.bio ?? "").trim();
  const tourName = optionalPlace(body.tourName);
  const city = optionalPlace(body.city);
  const country = optionalPlace(body.country);
  const starts = body.date ? eventStart(body.date, body.time) : null;
  await db.collection("gigs").doc(id).set({
    name,
    startsAt: starts,
    bio,
    image,
    tourName,
    city,
    country,
    live: false,
    creatorOrgId: org.id,
    memberIds: [org.id],
    members: { [org.id]: { role, kind: org.kind, name: org.name, profileImage: org.profileImage || null } },
    scannerCode: null,
    createdAt: new Date().toISOString(),
  });
  return gigView(await getDoc("gigs", id), org.id);
}

async function updateGig(token, gigId, body) {
  const org = await requireOrg(token);
  const gig = assertCreator(org.id, await assertOnGig(org.id, gigId));
  const name = body.name === undefined ? gig.name : String(body.name).trim();
  const bio = body.bio === undefined ? gig.bio : String(body.bio ?? "").trim();
  const tourName = body.tourName === undefined ? gig.tourName : optionalPlace(body.tourName);
  const city = body.city === undefined ? gig.city : optionalPlace(body.city);
  const country = body.country === undefined ? gig.country : optionalPlace(body.country);
  let starts = gig.startsAt || null;
  if (body.date || body.time) starts = eventStart(body.date, body.time);
  let image = gig.image || null;
  if (body.image) image = await saveImage(body.image);
  if (body.name !== undefined && !name) throw fail(400, "Enter the name of the event.");
  await db.collection("gigs").doc(gig.id).update({
    name: name || null,
    startsAt: starts,
    bio: bio ?? "",
    image,
    tourName,
    city,
    country,
  });
  return gigView(await getDoc("gigs", gig.id), org.id);
}

async function goLive(token, gigId) {
  const org = await requireOrg(token);
  const gig = assertCreator(org.id, await assertOnGig(org.id, gigId));
  if (!gigReady(gig)) throw fail(409, "Add a name, date, and image before this event can go live.");
  if (gig.live !== true) await db.collection("gigs").doc(gig.id).update({ live: true });
  return gigView(await getDoc("gigs", gig.id), org.id);
}

async function scannerCode(token, gigId) {
  const org = await requireOrg(token);
  const gig = assertCreator(org.id, await assertOnGig(org.id, gigId));
  if (gig.live !== true) throw fail(409, "This event is not live yet.");
  if (gig.scannerCode) {
    const old = await db.collection("scannerCodes").doc(gig.scannerCode).get();
    if (old.exists && !old.data().usedAt) await old.ref.delete();
  }
  let value = code(8);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await db.collection("scannerCodes").doc(value).create({ gigId: gig.id, usedAt: null });
      break;
    } catch (error) {
      value = code(8);
      if (attempt === 4) throw error;
    }
  }
  await db.collection("gigs").doc(gig.id).update({ scannerCode: value });
  return { code: value, qr: await scannerQr(value) };
}

async function deleteGig(token, gigId) {
  const org = await requireOrg(token);
  const gig = assertCreator(org.id, await assertOnGig(org.id, gigId));
  if (gig.startsAt && gig.live === true) throw fail(409, "A live event with a date cannot be deleted.");
  await deleteWhere("registrations", "gigId", gig.id);
  await deleteWhere("checkins", "gigId", gig.id);
  await deleteWhere("scannerCodes", "gigId", gig.id);
  const sessions = await db.collection("receiverSessions").where("gigId", "==", gig.id).get();
  for (const item of sessions.docs) await endReceiver(item.id);
  await db.collection("gigs").doc(gig.id).delete();
  return { ok: true };
}

async function addMember(token, gigId, body, slot) {
  const org = await requireOrg(token);
  assertCreator(org.id, await assertOnGig(org.id, gigId));
  const join = String(body.code ?? "").trim().toUpperCase();
  const gigRef = db.collection("gigs").doc(gigId);
  const codeRef = db.collection("joinCodes").doc(join);
  await db.runTransaction(async (tx) => {
    const gigSnap = await tx.get(gigRef);
    const codeSnap = await tx.get(codeRef);
    if (!gigSnap.exists) throw fail(404, "That event was not found.");
    const gig = gigSnap.data();
    if (!gig.memberIds?.includes(org.id)) throw fail(403, "That event belongs to someone else.");
    if (!codeSnap.exists || codeSnap.data().usedAt) throw fail(400, "That code has already been used.");
    const codeData = codeSnap.data();
    if (!codeData.expiresAt || new Date(codeData.expiresAt).getTime() <= Date.now()) throw fail(400, "That code has expired.");
    const otherSnap = await tx.get(db.collection("orgs").doc(codeData.orgId));
    if (!otherSnap.exists) throw fail(400, "That code was not found.");
    const other = otherSnap.data();
    const resolved = slot === "member" ? orgRole(other.kind) : slot;
    if (resolved === "act" && !["band", "team", "ensemble"].includes(other.kind)) throw fail(400, "That code is not from a band, team, or ensemble.");
    if (resolved === "venue" && other.kind !== "venue") throw fail(400, "That code is not from a venue.");
    if (gig.memberIds.includes(otherSnap.id)) throw fail(400, "They are already on this event.");
    if (resolved === "venue" && Object.values(gig.members || {}).some((member) => member.role === "venue")) {
      throw fail(400, "This event already has a venue.");
    }
    const members = { ...(gig.members || {}) };
    members[otherSnap.id] = { role: resolved, kind: other.kind, name: other.name, profileImage: other.profileImage || null };
    tx.update(codeRef, { usedAt: new Date().toISOString() });
    tx.update(gigRef, { members, memberIds: admin.firestore.FieldValue.arrayUnion(otherSnap.id) });
    if (other.joinCode === join) tx.update(otherSnap.ref, { joinCode: null });
  });
  return gigView(await getDoc("gigs", gigId), org.id);
}

async function registrationsFor(gigId) {
  const snap = await db.collection("registrations").where("gigId", "==", gigId).get();
  return snap.docs.map((item) => item.data());
}

async function getFans(ids) {
  const unique = [...new Set(ids)].filter(Boolean);
  const fans = [];
  for (let index = 0; index < unique.length; index += 100) {
    const refs = unique.slice(index, index + 100).map((id) => db.collection("fans").doc(id));
    if (!refs.length) continue;
    const snaps = await db.getAll(...refs);
    for (const snap of snaps) if (snap.exists) fans.push(docData(snap));
  }
  return fans;
}

async function registeredWith(fanId, orgId) {
  const snap = await db.collection("registrations").where("fanId", "==", fanId).get();
  for (const item of snap.docs) {
    const gig = await getDoc("gigs", item.data().gigId);
    if (gig?.memberIds?.includes(orgId)) return true;
  }
  return false;
}

async function lastTourName(orgId) {
  const named = (await gigsForOrg(orgId)).filter((gig) => String(gig.tourName || "").trim());
  named.sort((left, right) => String(right.startsAt || "").localeCompare(String(left.startsAt || "")));
  return named[0]?.tourName ?? null;
}

async function fansFor(org, target) {
  if (target.group === "gig") {
    await assertOnGig(org.id, target.gigId);
    return getFans((await registrationsFor(target.gigId)).map((row) => row.fanId));
  }
  if (target.group === "tour") {
    const tour = String(target.tourName || await lastTourName(org.id) || "").trim();
    if (!tour) throw fail(400, "Name a tour or series on an event before using the last one.");
    const ids = (await gigsForOrg(org.id)).filter((gig) => gig.tourName === tour).map((gig) => gig.id);
    const regs = (await Promise.all(ids.map((gigId) => registrationsFor(gigId)))).flat();
    return getFans(regs.map((row) => row.fanId));
  }
  if (target.group === "everyone") {
    const ids = (await gigsForOrg(org.id)).map((gig) => gig.id);
    const regs = (await Promise.all(ids.map((gigId) => registrationsFor(gigId)))).flat();
    return getFans(regs.map((row) => row.fanId));
  }
  if (target.group === "place") {
    const place = placeNeedle(target.place);
    if (!place) throw fail(400, "Enter a city or country for this code.");
    const gigs = await gigsForOrg(org.id);
    const regs = (await Promise.all(gigs.map((gig) => registrationsFor(gig.id)))).flat();
    const inPlace = new Set(gigs.filter((gig) => gigInPlace(gig, place)).map((gig) => gig.id));
    const attendedThere = new Set(regs.filter((row) => inPlace.has(row.gigId)).map((row) => row.fanId));
    const attendees = await getFans([...new Set(regs.map((row) => row.fanId))]);
    return attendees.flatMap((fan) => {
      const viaHome = fanHomePlace(fan, place);
      const viaGig = attendedThere.has(fan.id);
      if (!viaHome && !viaGig) return [];
      return [{ ...fan, placeVia: viaHome ? "home" : "gig", matchedPlace: place }];
    });
  }
  throw fail(400, "Choose a group.");
}

async function fansForPlaces(org, names) {
  const unique = [...new Set((names || []).map((name) => String(name).trim()).filter(Boolean))];
  const byFan = new Map();
  for (const place of unique) {
    for (const fan of await fansFor(org, { group: "place", place })) {
      const match = { place, via: fan.placeVia };
      const current = byFan.get(fan.id);
      if (current) current.matches.push(match);
      else byFan.set(fan.id, { ...fan, matches: [match] });
    }
  }
  return [...byFan.values()].map((fan) => {
    const chosen = preferPlace(fan, fan.matches);
    const display = chosen.label || chosen.place;
    return { ...fan, groups: display ? [`Fans from ${display}`] : [] };
  });
}

async function groupName(group) {
  const given = String(group?.label ?? "").trim();
  if (given) return given;
  const type = String(group?.type ?? group?.group ?? "");
  if (type === "all" || type === "everyone") return "All fans";
  if (type === "events" || type === "gig") {
    const ids = group.gigIds || (group.gigId ? [group.gigId] : []);
    const names = [];
    for (const id of ids) {
      const gig = await getDoc("gigs", id);
      if (gig?.name) names.push(gig.name);
    }
    return names.length ? `Attendees of ${names.join(", ")}` : "Attendees of an event";
  }
  if (type === "tours" || type === "tour") {
    const tours = (group.tours || (group.tourName ? [group.tourName] : [])).map((name) => String(name).trim()).filter(Boolean);
    return tours.length ? `Attendees of ${tours.join(", ")}` : "Attendees of a tour";
  }
  if (type === "places" || type === "place") {
    const names = (group.names || (group.place ? [group.place] : [])).map((name) => String(name).trim()).filter(Boolean);
    return names.length ? `Fans from ${names.join(", ")}` : "Fans from a place";
  }
  return "Group";
}

function mergeFanGroup(current, fan, label) {
  if (!label) return current;
  if (label.startsWith("Fans from ")) {
    const existing = current.groups.filter((item) => item.startsWith("Fans from "));
    const rest = current.groups.filter((item) => !item.startsWith("Fans from "));
    const preferred = preferPlace(fan, [...existing, label].map((item) => ({
      place: item.replace(/^Fans from /i, "").trim(),
      via: fanHomePlace(fan, placeNeedle(item.replace(/^Fans from /i, ""))) ? "home" : "gig",
    })));
    const placeLabel = preferred.label || preferred.place ? `Fans from ${preferred.label || preferred.place}` : label;
    current.groups = [...rest, placeLabel];
    return current;
  }
  if (!current.groups.includes(label)) current.groups.push(label);
  return current;
}

async function fansForSend(org, body) {
  if (Array.isArray(body.groups) && body.groups.length) {
    const found = new Map();
    const groups = [];
    for (const group of body.groups) {
      const type = String(group?.type ?? "");
      let rows = [];
      if (type === "all") {
        const label = await groupName(group);
        rows = (await fansFor(org, { group: "everyone" })).map((fan) => ({ ...fan, groups: [label] }));
      } else if (type === "events") {
        const label = await groupName(group);
        rows = (await Promise.all((group.gigIds || []).map((gigId) => fansFor(org, { group: "gig", gigId })))).flat()
          .map((fan) => ({ ...fan, groups: [label] }));
      } else if (type === "tours") {
        const label = await groupName(group);
        rows = (await Promise.all((group.tours || []).map((tourName) => fansFor(org, { group: "tour", tourName })))).flat()
          .map((fan) => ({ ...fan, groups: [label] }));
      } else if (type === "places") rows = await fansForPlaces(org, group.names || []);
      else throw fail(400, "Choose a group.");
      for (const fan of rows) {
        const label = (fan.groups || [])[0] || await groupName(group);
        if (label && !groups.includes(label)) groups.push(label);
        const current = found.get(fan.id);
        if (current) mergeFanGroup(current, fan, label);
        else found.set(fan.id, { ...fan, groups: label ? [label] : [] });
      }
    }
    const fans = [...found.values()];
    return { fans, groups: [...new Set(fans.flatMap((fan) => fan.groups || []))] };
  }
  if (body.group === "place" || body.group === "places") {
    const rows = await fansForPlaces(org, body.names || (body.place ? [body.place] : []));
    const groups = [...new Set(rows.flatMap((fan) => fan.groups || []))];
    return { fans: rows, groups };
  }
  const fans = await fansFor(org, body);
  const label = await groupName({ ...body, label: "" });
  return { fans: fans.map((fan) => ({ ...fan, groups: [label] })), groups: [label] };
}

function csvField(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function releaseCsv(rows) {
  const lines = ["sha256,username,groups"];
  const sorted = [...rows].sort((left, right) => String(left.username).localeCompare(String(right.username)) || String(left.hash).localeCompare(String(right.hash)));
  for (const row of sorted) lines.push([csvField(row.hash), csvField(row.username), csvField((row.groups || []).join("; "))].join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function cleanCsvName(label) {
  const cleaned = String(label).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return cleaned || "codes";
}

async function csvFilename(orgId, label) {
  const base = cleanCsvName(label);
  const [files] = await bucket.getFiles({ prefix: `codes/${orgId}/` });
  const taken = new Set(files.map((file) => file.name.slice(`codes/${orgId}/`.length)));
  let name = `${base}.csv`;
  let count = 2;
  while (taken.has(name)) {
    name = `${base} ${count}.csv`;
    count += 1;
  }
  return name;
}

async function takeCodes(count) {
  const found = [];
  const taken = new Set();
  while (found.length < count) {
    const guess = [];
    while (guess.length < count - found.length) {
      const value = code(8);
      if (taken.has(value)) continue;
      taken.add(value);
      guess.push(value);
    }
    for (let index = 0; index < guess.length; index += 100) {
      const chunk = guess.slice(index, index + 100);
      const snaps = await db.getAll(...chunk.map((value) => db.collection("priorityCodeValues").doc(value)));
      for (const snap of snaps) if (!snap.exists) found.push(snap.id);
    }
  }
  return found.slice(0, count);
}

async function sendCodes(token, body) {
  const org = await requireOrg(token);
  if (!org.profileImage && !body.image) throw fail(400, "Add a picture for this code.");
  const label = String(body.label ?? "").trim();
  if (!label) throw fail(400, "Name this code.");
  const message = String(body.message ?? "").trim();
  let expiresAt = String(body.expiresAt ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) expiresAt = `${expiresAt}T23:59:59.999Z`;
  if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) throw fail(400, "Enter the date this code expires.");
  const { fans, groups } = await fansForSend(org, body);
  if (!fans.length) throw fail(400, "Nobody in that group can receive a code yet.");
  const image = body.image ? await saveImage(body.image) : null;
  const batchId = randomUUID();
  const createdAt = new Date().toISOString();
  const filename = await csvFilename(org.id, label);
  const values = await takeCodes(fans.length);
  const jobs = fans.map((fan, index) => ({ id: randomUUID(), fan, value: values[index] }));
  for (let index = 0; index < jobs.length; index += 200) {
    const slice = jobs.slice(index, index + 200);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const batch = db.batch();
      for (const job of slice) {
        batch.create(db.collection("priorityCodeValues").doc(job.value), { id: job.id });
        batch.set(db.collection("priorityCodes").doc(job.id), {
          orgId: org.id,
          fanId: job.fan.id,
          label,
          code: job.value,
          inPerson: Boolean(body.inPerson),
          message,
          expiresAt: expiresAt || null,
          image,
          batchId,
          createdAt,
          groups,
          filename,
        });
      }
      try {
        await batch.commit();
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        const next = await takeCodes(slice.length);
        slice.forEach((job, offset) => {
          job.value = next[offset];
        });
      }
    }
  }
  const rows = jobs.map((job) => ({ hash: sha(job.value), username: job.fan.username || "", groups: job.fan.groups || [] }));
  await bucket.file(`codes/${org.id}/${filename}`).save(Buffer.from(releaseCsv(rows), "utf8"), {
    contentType: "text/csv; charset=utf-8",
    resumable: false,
  });
  await notifyFans(fans, org.name || "ticketID", label);
  return { count: fans.length, batch: batchId, filename };
}

async function saveDevice(token, body) {
  const fan = await requireFan(token);
  const value = String(body.token ?? "").trim();
  if (!value || value.length > 4096) throw fail(400, "That device could not be registered.");
  await db.collection("deviceTokens").doc(sha(value)).set({
    fanId: fan.id,
    token: value,
    updatedAt: new Date().toISOString(),
  });
  return { ok: true };
}

async function notifyFans(fans, title, body) {
  if (!fans.length || usingEmulator()) return;
  const tokens = [];
  const refs = [];
  const ids = [...new Set(fans.map((fan) => fan.id).filter(Boolean))];
  for (let index = 0; index < ids.length; index += 30) {
    const slice = ids.slice(index, index + 30);
    const snap = await db.collection("deviceTokens").where("fanId", "in", slice).get();
    for (const item of snap.docs) {
      const value = item.data().token;
      if (!value) continue;
      tokens.push(value);
      refs.push(item.ref);
    }
  }
  if (!tokens.length) return;
  for (let index = 0; index < tokens.length; index += 500) {
    const slice = tokens.slice(index, index + 500);
    const sliceRefs = refs.slice(index, index + 500);
    try {
      const result = await admin.messaging().sendEachForMulticast({
        tokens: slice,
        notification: { title, body },
        data: { kind: "code" },
        android: { priority: "high", notification: { channelId: "codes" } },
      });
      await Promise.all(result.responses.map(async (item, offset) => {
        const code = item.error?.code || "";
        if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
          await sliceRefs[offset].delete().catch(() => undefined);
        }
      }));
    } catch (error) {
      console.error(error);
    }
  }
}

async function issuedCodes(token) {
  const org = await requireOrg(token);
  const snap = await db.collection("priorityCodes").where("orgId", "==", org.id).get();
  const groups = new Map();
  for (const item of snap.docs) {
    const row = item.data();
    const batch = row.batchId || item.id;
    const current = groups.get(batch);
    if (!current) groups.set(batch, { ...row, count: 1, createdAt: row.createdAt });
    else {
      current.count += 1;
      if (String(row.createdAt) < String(current.createdAt)) current.createdAt = row.createdAt;
    }
  }
  return [...groups.entries()].map(([id, row]) => ({
    id,
    label: row.label,
    message: row.message || "",
    inPerson: row.inPerson === true,
    expiresAt: row.expiresAt || null,
    image: row.image ? `/media/${row.image}` : (org.profileImage ? `/media/${org.profileImage}` : null),
    createdAt: row.createdAt,
    count: row.count,
    groups: Array.isArray(row.groups) ? row.groups : [],
    filename: row.filename || null,
  })).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

async function sendReleaseCsv(response, token, batchId) {
  const org = await requireOrg(token);
  const snap = await db.collection("priorityCodes").where("batchId", "==", batchId).limit(1).get();
  const row = snap.empty ? null : snap.docs[0].data();
  if (!row || row.orgId !== org.id || !row.filename || /[\\/]/.test(row.filename)) throw fail(404, "That code release was not found.");
  const file = bucket.file(`codes/${org.id}/${row.filename}`);
  const [exists] = await file.exists();
  if (!exists) throw fail(404, "That file was not found.");
  const [buffer] = await file.download();
  const ascii = row.filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  response.status(200)
    .set("content-type", "text/csv; charset=utf-8")
    .set("content-disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`)
    .send(buffer);
  return SENT;
}

async function orgPlaces(token) {
  const org = await requireOrg(token);
  const gigs = await gigsForOrg(org.id);
  const regs = (await Promise.all(gigs.map((gig) => registrationsFor(gig.id)))).flat();
  const fans = await getFans([...new Set(regs.map((row) => row.fanId))]);
  const cities = new Set();
  const countries = new Set();
  for (const gig of gigs) {
    if (gig.city) cities.add(gig.city);
    if (gig.country) countries.add(gig.country);
  }
  for (const fan of fans) {
    if (fan.city) cities.add(fan.city);
    if (fan.country) countries.add(fan.country);
  }
  return {
    cities: [...cities].sort((left, right) => left.localeCompare(right)),
    countries: [...countries].sort((left, right) => left.localeCompare(right)),
  };
}

async function groupPreview(token, query) {
  const org = await requireOrg(token);
  const group = query.group || "everyone";
  const fans = await fansFor(org, { group, gigId: query.gigId || "", place: query.place || "", tourName: query.tourName || "" });
  return {
    count: fans.length,
    fans: fans.map((fan) => ({ id: fan.id, username: fan.username })),
    tourName: group === "tour" ? await lastTourName(org.id) : null,
  };
}

async function storeQr(store) {
  const links = {
    apple: "https://apps.apple.com/search?term=ticketID",
    google: "https://play.google.com/store/search?q=ticketID&c=apps",
  };
  const link = links[String(store || "")];
  if (!link) throw fail(404, "That store was not found.");
  return {
    qr: await QRCode.toDataURL(link, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 280,
      color: { dark: "#102e32", light: "#f3f1ea" },
    }),
  };
}

async function openReceiverSession(gigId) {
  const uid = `rcv_${randomUUID()}`;
  const email = `${uid}@receiver.ticketid.app`;
  const password = randomBytes(24).toString("base64url");
  try {
    await admin.auth().createUser({ uid, email, password });
    await admin.auth().setCustomUserClaims(uid, { actor: "receiver", gigId });
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + receiverTtlMs()).toISOString();
    await db.collection("receiverSessions").doc(uid).set({ gigId, createdAt, expiresAt });
    const signed = await identity("accounts:signInWithPassword", { email, password, returnSecureToken: true });
    let session = { idToken: signed.idToken, refreshToken: signed.refreshToken };
    const decoded = await admin.auth().verifyIdToken(session.idToken);
    if (decoded.actor !== "receiver" || decoded.gigId !== gigId) {
      const refreshed = await exchangeRefresh(session.refreshToken);
      session = { idToken: refreshed.token, refreshToken: refreshed.refreshToken };
    }
    return session;
  } catch (error) {
    await endReceiver(uid);
    throw error;
  }
}

async function listReceivers(token, gigId) {
  const org = await requireOrg(token);
  assertCreator(org.id, await assertOnGig(org.id, gigId));
  const snap = await db.collection("receiverSessions").where("gigId", "==", gigId).get();
  const now = Date.now();
  return snap.docs
    .filter((item) => {
      const expires = item.data().expiresAt;
      return !expires || new Date(expires).getTime() > now;
    })
    .map((item) => ({ id: item.id, signedInAt: item.data().createdAt, expiresAt: item.data().expiresAt || null }))
    .sort((left, right) => String(left.signedInAt).localeCompare(String(right.signedInAt)));
}

async function disconnectReceiver(token, gigId, receiverId) {
  const org = await requireOrg(token);
  assertCreator(org.id, await assertOnGig(org.id, gigId));
  const row = await getDoc("receiverSessions", receiverId);
  if (!row || row.gigId !== gigId) throw fail(404, "That scanner is not signed in.");
  await endReceiver(receiverId);
  return { ok: true };
}

async function receiverLogin(body) {
  const raw = String(body.code ?? body.eventCode ?? "").trim();
  const packed = raw.match(/^ticketid:([A-Za-z0-9]+)$/i);
  const value = (packed ? packed[1] : raw).toUpperCase();
  const ref = value ? db.collection("scannerCodes").doc(value) : null;
  let gigId = "";
  if (!ref) throw fail(401, "That scanner code was not found.");
  await db.runTransaction(async (tx) => {
    const row = await tx.get(ref);
    if (!row.exists) throw fail(401, "That scanner code was not found.");
    if (row.data().usedAt) throw fail(401, "That scanner code has already been used.");
    const gigSnap = await tx.get(db.collection("gigs").doc(row.data().gigId));
    const gig = gigSnap.exists ? gigSnap.data() : null;
    if (!gig || gig.live !== true) throw fail(409, "This event is not live yet.");
    if (!gigReady(gig)) throw fail(409, "Add a name, date, and image before check-in.");
    gigId = gigSnap.id;
    tx.update(ref, { usedAt: new Date().toISOString() });
    tx.update(gigSnap.ref, { scannerCode: null });
  });
  try {
    const session = await openReceiverSession(gigId);
    const gig = await getDoc("gigs", gigId);
    return sessionBody(session, { image: `/media/${gig.image}`, name: gig.name });
  } catch (error) {
    await ref.update({ usedAt: null }).catch(() => undefined);
    await db.collection("gigs").doc(gigId).update({ scannerCode: value }).catch(() => undefined);
    throw error;
  }
}

async function receiverEvent(token) {
  const gig = await requireReceiver(token);
  return { image: `/media/${gig.image}`, name: gig.name };
}

async function scan(token, body) {
  const gig = await requireReceiver(token);
  if (!gigReady(gig)) throw fail(409, "Check-in is not open for this event.");
  const raw = String(body.code ?? "").trim().toUpperCase();
  const hashRef = db.collection("checkinHashes").doc(sha(raw));
  await db.runTransaction(async (tx) => {
    const link = await tx.get(hashRef);
    if (!link.exists) throw fail(400, "That code was not found.");
    const checkinRef = db.collection("checkins").doc(link.data().id);
    const row = await tx.get(checkinRef);
    if (!row.exists) throw fail(400, "That code was not found.");
    const data = row.data();
    if (data.usedAt) throw fail(400, "That code has already been used.");
    if (new Date(data.expiresAt).getTime() < Date.now()) throw fail(400, "That code has expired.");
    const regRef = db.collection("registrations").doc(`${data.fanId}_${gig.id}`);
    const existing = await tx.get(regRef);
    const registeredAt = new Date().toISOString();
    tx.update(checkinRef, { usedAt: registeredAt, gigId: gig.id });
    if (!existing.exists) tx.set(regRef, { fanId: data.fanId, gigId: gig.id, registeredAt });
  });
  return { ok: true };
}

async function latestMail(email) {
  if (!usingEmulator()) throw fail(404, "That page was not found.");
  const snap = await db.collection("mail").where("email", "==", cleanEmail(email)).get();
  const rows = snap.docs.map((item) => item.data()).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  if (!rows[0]) return { body: "" };
  return { subject: rows[0].subject, body: rows[0].body, created_at: rows[0].createdAt };
}

async function handle(request, response) {
  services();
  const path = routePath(request);
  const body = request.body || {};
  const token = bearer(request);
  if (path.startsWith("/api/fan/") && path !== "/api/fan/recover" && path !== "/api/fan/recover/confirm") {
    await requireAppCheck(request);
  }
  if (request.method === "GET" && path.startsWith("/media/")) return sendMedia(response, path.slice("/media/".length));
  if (request.method === "GET" && path === "/api/health") {
    return { ok: true };
  }
  if (request.method === "POST" && path === "/api/session/refresh") return exchangeRefresh(String(body.refreshToken || ""));
  if (request.method === "POST" && path === "/api/fan/signup") return signupFan(body);
  if (request.method === "POST" && path === "/api/org/signup") return signupOrg(body);
  if (request.method === "POST" && path === "/api/verify") return { ok: true, actor: body.actor === "org" ? "org" : "fan" };
  if (request.method === "POST" && path === "/api/resend") return { ok: true };
  if (request.method === "POST" && path === "/api/fan/login") return loginAccount(body, "fan");
  if (request.method === "POST" && path === "/api/org/login") return loginAccount(body, "org");
  if (request.method === "POST" && path === "/api/logout") return logout(token);
  if (request.method === "GET" && path === "/api/fan/me") return publicFan(await requireFan(token));
  if (request.method === "PATCH" && path === "/api/fan/me") return updateFan(token, body);
  if (request.method === "POST" && path === "/api/fan/password") return changeFanPassword(token, body);
  if (request.method === "POST" && path === "/api/fan/recover") return recoverFan(body);
  if (request.method === "POST" && path === "/api/fan/recover/confirm") return confirmFanRecovery(body);
  if (request.method === "POST" && path === "/api/fan/checkin") return mintCheckin(token);
  if (request.method === "GET" && path.startsWith("/api/fan/checkin/")) return checkinStatus(token, path.split("/").pop());
  if (request.method === "GET" && path === "/api/fan/gigs") return fanGigs(token);
  if (request.method === "GET" && path === "/api/fan/codes") return fanCodes(token);
  if (request.method === "POST" && path === "/api/fan/device") return saveDevice(token, body);
  if (request.method === "GET" && path === "/api/org/me") return publicOrg(await requireOrg(token));
  if (request.method === "PATCH" && path === "/api/org/me") return updateOrg(token, body);
  if (request.method === "POST" && path === "/api/org/join-code") return newJoinCode(token);
  if (request.method === "GET" && path === "/api/gigs") return listGigs(token);
  if (request.method === "POST" && path === "/api/gigs") return createGig(token, body);
  if (request.method === "GET" && /^\/api\/gigs\/[^/]+$/.test(path)) {
    const org = await requireOrg(token);
    return gigView(await assertOnGig(org.id, path.split("/")[3]), org.id);
  }
  if (request.method === "PATCH" && /^\/api\/gigs\/[^/]+$/.test(path)) return updateGig(token, path.split("/")[3], body);
  if (request.method === "DELETE" && /^\/api\/gigs\/[^/]+$/.test(path)) return deleteGig(token, path.split("/")[3]);
  if (request.method === "POST" && /^\/api\/gigs\/[^/]+\/live$/.test(path)) return goLive(token, path.split("/")[3]);
  if (request.method === "POST" && /^\/api\/gigs\/[^/]+\/scanner$/.test(path)) return scannerCode(token, path.split("/")[3]);
  if (request.method === "GET" && /^\/api\/gigs\/[^/]+\/receivers$/.test(path)) return listReceivers(token, path.split("/")[3]);
  if (request.method === "DELETE" && /^\/api\/gigs\/[^/]+\/receivers\/[^/]+$/.test(path)) {
    const parts = path.split("/");
    return disconnectReceiver(token, parts[3], parts[5]);
  }
  if (request.method === "POST" && /^\/api\/gigs\/[^/]+\/acts$/.test(path)) return addMember(token, path.split("/")[3], body, "act");
  if (request.method === "POST" && /^\/api\/gigs\/[^/]+\/venue$/.test(path)) return addMember(token, path.split("/")[3], body, "venue");
  if (request.method === "POST" && /^\/api\/gigs\/[^/]+\/members$/.test(path)) return addMember(token, path.split("/")[3], body, "member");
  if (request.method === "GET" && path === "/api/groups") return groupPreview(token, request.query || {});
  if (request.method === "GET" && path === "/api/places") return orgPlaces(token);
  if (request.method === "GET" && /^\/api\/codes\/[^/]+$/.test(path)) return sendReleaseCsv(response, token, path.split("/")[3]);
  if (request.method === "GET" && path === "/api/codes") return issuedCodes(token);
  if (request.method === "POST" && path === "/api/codes") return sendCodes(token, body);
  if (request.method === "GET" && path === "/api/store-qr") return storeQr(request.query?.store);
  if (request.method === "POST" && path === "/api/receiver/login") return receiverLogin(body);
  if (request.method === "GET" && path === "/api/receiver/event") return receiverEvent(token);
  if (request.method === "POST" && path === "/api/receiver/scan") return scan(token, body);
  if (request.method === "GET" && path === "/api/dev/mail") return latestMail(request.query?.email);
  throw fail(404, "That page was not found.");
}

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "3mb" }));
  app.use((req, res, next) => {
    res.set("access-control-allow-origin", "*");
    res.set("access-control-allow-headers", "authorization, content-type");
    res.set("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });
  app.use(async (req, res) => {
    try {
      const result = await handle(req, res);
      if (result === SENT || res.headersSent) return;
      res.status(200).json(result ?? {});
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) console.error(error);
      if (!res.headersSent) res.status(status).json({ message: status >= 500 ? "Something went wrong." : error.message });
    }
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const unreadable = error.type === "entity.parse.failed";
    res.status(unreadable ? 400 : 500).json({ message: unreadable ? "That request could not be read." : "Something went wrong." });
  });
  return app;
}

async function resetData() {
  services();
  for (const name of collections) await clearCollection(name);
  const listed = await admin.auth().listUsers(1000);
  if (listed.users.length) await admin.auth().deleteUsers(listed.users.map((user) => user.uid));
}

module.exports = { createApp, resetData };
