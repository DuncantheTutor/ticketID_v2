import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function createApp(db, dataDir) {
  const mediaDir = path.join(dataDir, "media");

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

  function hashPassword(password) {
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 32).toString("hex");
    return `${salt}:${hash}`;
  }

  function checkPassword(password, stored) {
    const [salt, hash] = String(stored).split(":");
    if (!salt || !hash) return false;
    const next = scryptSync(password, salt, 32);
    const previous = Buffer.from(hash, "hex");
    if (next.length !== previous.length) return false;
    return timingSafeEqual(next, previous);
  }

  function same(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  function cleanEmail(value) {
    return String(value ?? "").trim().toLowerCase();
  }

  function optionalPlace(value) {
    const text = String(value ?? "").trim();
    return text || null;
  }

  function assertPassword(password) {
    const value = String(password ?? "");
    if (value.length < 8 || !/[A-Z]/.test(value) || !/[0-9]/.test(value) || !/[^A-Za-z0-9]/.test(value)) {
      throw fail(400, "Use at least 8 characters, with one capital letter, one number, and one special character.");
    }
  }

  function samePhone(left, right) {
    const trimPhone = (value) => String(value ?? "").replace(/\D/g, "").replace(/^0+/, "").replace(/^44/, "");
    const a = trimPhone(left);
    const b = trimPhone(right);
    return a.length >= 8 && a === b;
  }

  function fanByContact(contact) {
    const text = String(contact ?? "").trim();
    if (!text) return null;
    if (text.includes("@")) return db.prepare("SELECT * FROM fans WHERE email = ?").get(cleanEmail(text)) ?? null;
    return db.prepare("SELECT * FROM fans").all().find((fan) => samePhone(fan.phone, text)) ?? null;
  }

  function publicFan(fan) {
    return {
      id: fan.id,
      username: fan.username,
      email: fan.email,
      phone: fan.phone,
      city: fan.city,
      country: fan.country,
      registeredOnly: fan.registered_only === 1,
    };
  }

  function publicOrg(org) {
    return {
      id: org.id,
      kind: org.kind,
      name: org.name,
      email: org.email,
      profileImage: org.profile_image ? `/media/${org.profile_image}` : null,
    };
  }

  function saveImage(dataUrl) {
    const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl ?? ""));
    if (!match) throw fail(400, "Use a PNG, JPEG, or WebP image.");
    const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
    if (!buffer.length || buffer.length > 1_500_000) throw fail(400, "Use an image under 1.5 MB.");
    const ext = match[1].includes("png") ? "png" : match[1].includes("webp") ? "webp" : "jpg";
    const filename = `${randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(mediaDir, filename), buffer);
    return filename;
  }

  function sessionFor(token, actor) {
    if (!token) throw fail(401, "Sign in to continue.");
    const row = db.prepare("SELECT actor, actor_id FROM sessions WHERE token_hash = ?").get(sha(token));
    if (!row || row.actor !== actor) throw fail(401, "Sign in to continue.");
    return row;
  }

  function bearer(request) {
    const header = request.headers.authorization ?? "";
    return header.startsWith("Bearer ") ? header.slice(7) : "";
  }

  function openSession(actor, actorId) {
    const token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (token_hash, actor, actor_id, created_at) VALUES (?, ?, ?, ?)").run(sha(token), actor, actorId, new Date().toISOString());
    return token;
  }

  function sendMail(origin, email, actor) {
    const verifyCode = code(6);
    const token = randomBytes(24).toString("hex");
    const account = actor === "fan"
      ? db.prepare("SELECT id FROM fans WHERE email = ?").get(email)
      : db.prepare("SELECT id FROM orgs WHERE email = ?").get(email);
    if (!account) throw fail(404, "That account was not found.");
    db.prepare("UPDATE verifications SET used = 1 WHERE actor = ? AND actor_id = ? AND used = 0").run(actor, account.id);
    db.prepare(`INSERT INTO verifications (id, actor, actor_id, email, code, token_hash, expires_at, used)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)`).run(randomUUID(), actor, account.id, email, verifyCode, sha(token), new Date(Date.now() + 1000 * 60 * 30).toISOString());
    const link = `${origin}/verify?token=${token}`;
    const body = `Confirm your email for ticketID.\n\nOpen this link:\n${link}\n\nOr enter this code: ${verifyCode}\n\nThe code expires in 30 minutes.`;
    db.prepare("INSERT INTO mail (id, email, subject, body, created_at) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), email, "Confirm your email", body, new Date().toISOString());
    if (process.env.NODE_ENV !== "production") console.log(`\nEmail to ${email}\n${body}\n`);
    return { code: verifyCode, link };
  }

  function confirmToken(token) {
    const row = db.prepare("SELECT * FROM verifications WHERE token_hash = ?").get(sha(token));
    if (!row || row.used || new Date(row.expires_at).getTime() < Date.now()) throw fail(400, "That confirmation link has expired.");
    markVerified(row);
    return row;
  }

  function confirmCode(actor, email, verifyCode) {
    const row = db.prepare(`SELECT * FROM verifications
      WHERE actor = ? AND email = ? AND code = ? AND used = 0
      ORDER BY expires_at DESC LIMIT 1`).get(actor, cleanEmail(email), String(verifyCode ?? "").trim().toUpperCase());
    if (!row || new Date(row.expires_at).getTime() < Date.now()) throw fail(400, "That code has expired. Send the email again.");
    markVerified(row);
  }

  function markVerified(row) {
    db.prepare("UPDATE verifications SET used = 1 WHERE id = ?").run(row.id);
    if (row.actor === "fan") db.prepare("UPDATE fans SET verified = 1 WHERE id = ?").run(row.actor_id);
    else db.prepare("UPDATE orgs SET verified = 1 WHERE id = ?").run(row.actor_id);
  }

  function requireVerifiedFan(token) {
    const session = sessionFor(token, "fan");
    const fan = db.prepare("SELECT * FROM fans WHERE id = ?").get(session.actor_id);
    if (!fan || !fan.verified) throw fail(401, "Confirm your email to continue.");
    return fan;
  }

  function requireVerifiedOrg(token) {
    const session = sessionFor(token, "org");
    const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(session.actor_id);
    if (!org || !org.verified) throw fail(401, "Confirm your email to continue.");
    return org;
  }

  function gigReady(gig) {
    return Boolean(gig?.name && gig?.image && gig?.starts_at);
  }

  function members(gigId) {
    return db.prepare(`SELECT o.id, o.kind, o.name, o.profile_image, g.role
      FROM gig_orgs g JOIN orgs o ON o.id = g.org_id
      WHERE g.gig_id = ? ORDER BY o.name`).all(gigId).map((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      role: row.role,
      profileImage: row.profile_image ? `/media/${row.profile_image}` : null,
    }));
  }

  function gigView(gig) {
    const live = gig.live === 1;
    return {
      id: gig.id,
      name: gig.name,
      startsAt: gig.starts_at,
      bio: gig.bio,
      tourName: gig.tour_name,
      city: gig.city || "",
      country: gig.country || "",
      image: gig.image ? `/media/${gig.image}` : null,
      ready: gigReady(gig),
      live,
      members: members(gig.id),
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
      margin: 1,
      width: 280,
      color: { dark: "#102e32", light: "#f3f1ea" },
    });
  }

  function assertOnGig(orgId, gigId) {
    const gig = db.prepare("SELECT * FROM gigs WHERE id = ?").get(gigId);
    if (!gig) throw fail(404, "That event was not found.");
    const seat = db.prepare("SELECT role FROM gig_orgs WHERE gig_id = ? AND org_id = ?").get(gigId, orgId);
    if (!seat) throw fail(403, "That event belongs to someone else.");
    return gig;
  }

  function lastTourName(orgId) {
    const row = db.prepare(`SELECT g.tour_name FROM gigs g
      JOIN gig_orgs s ON s.gig_id = g.id
      WHERE s.org_id = ? AND g.tour_name IS NOT NULL AND trim(g.tour_name) != ''
      ORDER BY g.starts_at DESC LIMIT 1`).get(orgId);
    return row?.tour_name ?? null;
  }

  function fansFor(org, target) {
    const registeredClause = `(f.registered_only = 0 OR EXISTS (
      SELECT 1 FROM registrations r2
      JOIN gig_orgs s2 ON s2.gig_id = r2.gig_id
      WHERE r2.fan_id = f.id AND s2.org_id = ?
    ))`;
    if (target.group === "gig") {
      assertOnGig(org.id, target.gigId);
      return db.prepare(`SELECT DISTINCT f.* FROM fans f
        JOIN registrations r ON r.fan_id = f.id
        WHERE r.gig_id = ? AND ${registeredClause}`).all(target.gigId, org.id);
    }
    if (target.group === "tour") {
      const tour = String(target.tourName || lastTourName(org.id) || "").trim();
      if (!tour) throw fail(400, "Name a tour or series on an event before using the last one.");
      return db.prepare(`SELECT DISTINCT f.* FROM fans f
        JOIN registrations r ON r.fan_id = f.id
        JOIN gigs g ON g.id = r.gig_id
        JOIN gig_orgs s ON s.gig_id = g.id
        WHERE s.org_id = ? AND g.tour_name = ? AND ${registeredClause}`).all(org.id, tour, org.id);
    }
    if (target.group === "everyone") {
      return db.prepare(`SELECT DISTINCT f.* FROM fans f
        JOIN registrations r ON r.fan_id = f.id
        JOIN gig_orgs s ON s.gig_id = r.gig_id
        WHERE s.org_id = ? AND ${registeredClause}`).all(org.id, org.id);
    }
    if (target.group === "place") {
      const place = String(target.place ?? "").trim().toLowerCase();
      if (!place) throw fail(400, "Enter a city or country for this code.");
      return db.prepare(`SELECT * FROM fans f
        WHERE (lower(coalesce(city, '')) = ? OR lower(coalesce(country, '')) = ? OR lower(coalesce(hometown, '')) = ?)
        AND ${registeredClause}`).all(place, place, place, org.id);
    }
    throw fail(400, "Choose a group.");
  }

  async function handle(request, response, url) {
    const origin = `${url.protocol}//${url.host}`;
    if (url.pathname.startsWith("/media/")) return sendMedia(response, url.pathname.slice("/media/".length));
    if (url.pathname.startsWith("/api/")) return handleApi(request, response, url, origin);
    return sendPage(response, url.pathname);
  }

  function sendMedia(response, name) {
    if (!/^[\w.-]+$/.test(name)) return sendJson(response, 404, { message: "That image was not found." });
    const file = path.join(mediaDir, name);
    if (!file.startsWith(mediaDir) || !fs.existsSync(file)) return sendJson(response, 404, { message: "That image was not found." });
    const ext = path.extname(file).slice(1);
    const type = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    response.writeHead(200, { "content-type": type, "cache-control": "public, max-age=86400" });
    fs.createReadStream(file).pipe(response);
  }

  function sendPage(response, pathname) {
    const routed = pathname === "/verify" ? "/fan/index.html" : pathname;
    const relative = routed === "/" ? "/fan/index.html" : routed;
    const filePath = safeFile(relative);
    if (!filePath) {
      const fallback = pathname.startsWith("/receiver") ? "/receiver/index.html" : pathname.startsWith("/dashboard") ? "/dashboard/index.html" : "/fan/index.html";
      return sendFile(response, safeFile(fallback), "text/html; charset=utf-8");
    }
    return sendFile(response, filePath, contentType(filePath));
  }

  function safeFile(pathname) {
    const cleaned = decodeURIComponent(pathname).replace(/^[/\\]+/, "");
    if (!cleaned || cleaned.includes("..")) return null;
    const filePath = path.join(publicDir, cleaned);
    if (!filePath.startsWith(publicDir)) return null;
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return filePath;
    return null;
  }

  function contentType(filePath) {
    const ext = path.extname(filePath);
    if (ext === ".html") return "text/html; charset=utf-8";
    if (ext === ".css") return "text/css; charset=utf-8";
    if (ext === ".js") return "text/javascript; charset=utf-8";
    if (ext === ".svg") return "image/svg+xml";
    return "application/octet-stream";
  }

  function sendFile(response, filePath, type) {
    response.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    fs.createReadStream(filePath).pipe(response);
  }

  async function handleApi(request, response, url, origin) {
    const body = await readBody(request);
    const token = bearer(request);
    const route = `${request.method} ${url.pathname}`;

    if (route === "POST /api/fan/signup") return signupFan(origin, body);
    if (route === "POST /api/org/signup") return signupOrg(origin, body);
    if (route === "POST /api/verify") return verify(body);
    if (route === "POST /api/resend") return resend(origin, body);
    if (route === "POST /api/fan/login") return loginFan(body);
    if (route === "POST /api/org/login") return loginOrg(body);
    if (route === "POST /api/logout") return logout(token);
    if (route === "GET /api/fan/me") return publicFan(requireVerifiedFan(token));
    if (route === "PATCH /api/fan/me") return updateFan(token, body);
    if (route === "POST /api/fan/password") return changeFanPassword(token, body);
    if (route === "POST /api/fan/recover") return recoverFan(body);
    if (route === "POST /api/fan/recover/confirm") return confirmFanRecovery(body);
    if (route === "POST /api/fan/checkin") return mintCheckin(token);
    if (request.method === "GET" && url.pathname.startsWith("/api/fan/checkin/")) return checkinStatus(token, url.pathname.split("/").pop());
    if (route === "GET /api/fan/gigs") return fanGigs(token);
    if (route === "GET /api/fan/codes") return fanCodes(token);
    if (route === "GET /api/org/me") return publicOrg(requireVerifiedOrg(token));
    if (route === "PATCH /api/org/me") return updateOrg(token, body);
    if (route === "POST /api/org/join-code") return newJoinCode(token);
    if (route === "GET /api/gigs") return listGigs(token);
    if (route === "POST /api/gigs") return createGig(token, body);
    if (request.method === "GET" && /^\/api\/gigs\/[^/]+$/.test(url.pathname)) return getGig(token, url.pathname.split("/")[3]);
    if (request.method === "PATCH" && /^\/api\/gigs\/[^/]+$/.test(url.pathname)) return updateGig(token, url.pathname.split("/")[3], body);
    if (request.method === "DELETE" && /^\/api\/gigs\/[^/]+$/.test(url.pathname)) return deleteGig(token, url.pathname.split("/")[3]);
    if (request.method === "POST" && /^\/api\/gigs\/[^/]+\/live$/.test(url.pathname)) return goLive(token, url.pathname.split("/")[3]);
    if (request.method === "POST" && /^\/api\/gigs\/[^/]+\/scanner$/.test(url.pathname)) return scannerCode(token, url.pathname.split("/")[3]);
    if (request.method === "POST" && /^\/api\/gigs\/[^/]+\/acts$/.test(url.pathname)) return addMember(token, url.pathname.split("/")[3], body, "act");
    if (request.method === "POST" && /^\/api\/gigs\/[^/]+\/venue$/.test(url.pathname)) return addMember(token, url.pathname.split("/")[3], body, "venue");
    if (request.method === "POST" && /^\/api\/gigs\/[^/]+\/members$/.test(url.pathname)) return addMember(token, url.pathname.split("/")[3], body, "member");
    if (route === "GET /api/groups") return groupPreview(token, url);
    if (route === "GET /api/codes") return issuedCodes(token);
    if (route === "POST /api/codes") return sendCodes(token, body);
    if (route === "GET /api/store-qr") return storeQr(url.searchParams.get("store"));
    if (route === "POST /api/receiver/login") return receiverLogin(body);
    if (route === "GET /api/receiver/event") return receiverEvent(token);
    if (route === "POST /api/receiver/scan") return scan(token, body);
    if (route === "GET /api/dev/mail") {
      if (process.env.NODE_ENV === "production") throw fail(404, "That page was not found.");
      const email = cleanEmail(url.searchParams.get("email"));
      const row = db.prepare("SELECT subject, body, created_at FROM mail WHERE email = ? ORDER BY created_at DESC LIMIT 1").get(email);
      return row ?? { body: "" };
    }
    throw fail(404, "That page was not found.");
  }

  function signupFan(origin, body) {
    const username = String(body.username ?? "").trim();
    const email = cleanEmail(body.email);
    const phone = String(body.phone ?? "").trim();
    const password = String(body.password ?? "");
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw fail(400, "Use a username of 3 to 20 letters, numbers, or underscores.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, "Enter a valid email address.");
    if (phone.replace(/\D/g, "").length < 8) throw fail(400, "Enter a phone number.");
    assertPassword(password);
    if (db.prepare("SELECT id FROM fans WHERE email = ?").get(email)) throw fail(400, "That email is already registered.");
    if (db.prepare("SELECT id FROM fans WHERE lower(username) = ?").get(username.toLowerCase())) throw fail(400, "That username is taken.");
    const id = randomUUID();
    db.prepare(`INSERT INTO fans (id, username, email, phone, password_hash, hometown, city, country, registered_only, verified, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 0, 0, ?)`).run(id, username, email, phone, hashPassword(password), optionalPlace(body.city ?? body.hometown), optionalPlace(body.country), new Date().toISOString());
    sendMail(origin, email, "fan");
    return { pending: true, email };
  }

  function signupOrg(origin, body) {
    const kind = String(body.kind ?? "");
    const name = String(body.name ?? "").trim();
    const email = cleanEmail(body.email);
    const password = String(body.password ?? "");
    if (!["band", "team", "ensemble", "organiser", "venue", "festival"].includes(kind)) throw fail(400, "Choose what kind of account this is.");
    if (!name) throw fail(400, "Enter a name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, "Enter a valid email address.");
    assertPassword(password);
    if (db.prepare("SELECT id FROM orgs WHERE email = ?").get(email)) throw fail(400, "That email is already registered.");
    const id = randomUUID();
    db.prepare(`INSERT INTO orgs (id, kind, name, email, password_hash, profile_image, verified, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, 0, ?)`).run(id, kind, name, email, hashPassword(password), new Date().toISOString());
    sendMail(origin, email, "org");
    return { pending: true, email };
  }

  function verify(body) {
    if (body.token) return { ok: true, actor: confirmToken(String(body.token)).actor };
    const actor = body.actor === "org" ? "org" : "fan";
    confirmCode(actor, body.email, body.code);
    return { ok: true, actor };
  }

  function resend(origin, body) {
    const actor = body.actor === "org" ? "org" : "fan";
    const email = cleanEmail(body.email);
    const account = actor === "fan"
      ? db.prepare("SELECT verified FROM fans WHERE email = ?").get(email)
      : db.prepare("SELECT verified FROM orgs WHERE email = ?").get(email);
    if (!account) throw fail(404, "That account was not found.");
    if (account.verified) throw fail(400, "That email is already confirmed.");
    sendMail(origin, email, actor);
    return { ok: true };
  }

  function loginFan(body) {
    const fan = db.prepare("SELECT * FROM fans WHERE email = ?").get(cleanEmail(body.email));
    if (!fan || !checkPassword(String(body.password ?? ""), fan.password_hash)) throw fail(401, "That email or password is wrong.");
    if (!fan.verified) throw fail(403, "Confirm your email to sign in.");
    return { token: openSession("fan", fan.id) };
  }

  function loginOrg(body) {
    const org = db.prepare("SELECT * FROM orgs WHERE email = ?").get(cleanEmail(body.email));
    if (!org || !checkPassword(String(body.password ?? ""), org.password_hash)) throw fail(401, "That email or password is wrong.");
    if (!org.verified) throw fail(403, "Confirm your email to sign in.");
    return { token: openSession("org", org.id) };
  }

  function logout(token) {
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token));
    return { ok: true };
  }

  function updateFan(token, body) {
    const fan = requireVerifiedFan(token);
    const username = body.username === undefined ? fan.username : String(body.username).trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw fail(400, "Use a username of 3 to 20 letters, numbers, or underscores.");
    const taken = db.prepare("SELECT id FROM fans WHERE lower(username) = ? AND id != ?").get(username.toLowerCase(), fan.id);
    if (taken) throw fail(400, "That username is taken.");
    const phone = body.phone === undefined ? fan.phone : String(body.phone).trim();
    if (phone.replace(/\D/g, "").length < 8) throw fail(400, "Enter a phone number.");
    let email = fan.email;
    if (body.email !== undefined) {
      email = cleanEmail(body.email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, "Enter a valid email address.");
      const takenEmail = db.prepare("SELECT id FROM fans WHERE email = ? AND id != ?").get(email, fan.id);
      if (takenEmail) throw fail(400, "That email is already registered.");
    }
    const city = body.city !== undefined ? optionalPlace(body.city) : body.hometown !== undefined ? optionalPlace(body.hometown) : fan.city;
    const country = body.country === undefined ? fan.country : optionalPlace(body.country);
    const registeredOnly = body.registeredOnly === undefined ? fan.registered_only : body.registeredOnly ? 1 : 0;
    db.prepare(`UPDATE fans SET username = ?, email = ?, phone = ?, city = ?, country = ?, registered_only = ? WHERE id = ?`)
      .run(username, email, phone, city, country, registeredOnly, fan.id);
    return publicFan(db.prepare("SELECT * FROM fans WHERE id = ?").get(fan.id));
  }

  function changeFanPassword(token, body) {
    const fan = requireVerifiedFan(token);
    if (!checkPassword(String(body.currentPassword ?? ""), fan.password_hash)) throw fail(401, "That password is wrong.");
    const password = String(body.password ?? "");
    if (password !== String(body.confirm ?? "")) throw fail(400, "Enter the same new password twice.");
    assertPassword(password);
    db.prepare("UPDATE fans SET password_hash = ? WHERE id = ?").run(hashPassword(password), fan.id);
    return { ok: true };
  }

  function recoverFan(body) {
    const contact = String(body.contact ?? "").trim();
    if (!contact) throw fail(400, "Enter the email or phone number on the account.");
    const fan = fanByContact(contact);
    if (!fan) throw fail(404, "We could not find an account with that email or phone number.");
    const resetCode = code(6);
    db.prepare("UPDATE password_resets SET used = 1 WHERE fan_id = ? AND used = 0").run(fan.id);
    db.prepare("INSERT INTO password_resets (id, fan_id, email, code, expires_at, used) VALUES (?, ?, ?, ?, ?, 0)")
      .run(randomUUID(), fan.id, fan.email, resetCode, new Date(Date.now() + 1000 * 60 * 30).toISOString());
    const message = `Reset your password for ticketID.\n\nEnter this code: ${resetCode}\n\nThe code expires in 30 minutes.`;
    db.prepare("INSERT INTO mail (id, email, subject, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), fan.email, "Reset your password", message, new Date().toISOString());
    if (process.env.NODE_ENV !== "production") console.log(`\nEmail to ${fan.email}\n${message}\n`);
    return { email: fan.email };
  }

  function confirmFanRecovery(body) {
    const email = cleanEmail(body.email);
    const resetCode = String(body.code ?? "").trim().toUpperCase();
    const password = String(body.password ?? "");
    if (password !== String(body.confirm ?? "")) throw fail(400, "Enter the same new password twice.");
    assertPassword(password);
    const row = db.prepare(`SELECT * FROM password_resets
      WHERE email = ? AND code = ? AND used = 0
      ORDER BY expires_at DESC LIMIT 1`).get(email, resetCode);
    if (!row || new Date(row.expires_at).getTime() < Date.now()) throw fail(400, "That code has expired. Send a new one.");
    db.prepare("UPDATE password_resets SET used = 1 WHERE id = ?").run(row.id);
    db.prepare("UPDATE fans SET password_hash = ? WHERE id = ?").run(hashPassword(password), row.fan_id);
    return { ok: true };
  }

  async function mintCheckin(token) {
    const fan = requireVerifiedFan(token);
    const ttl = Number(process.env.CHECKIN_MS || 10_000);
    const raw = code(10);
    const id = randomUUID();
    db.prepare("UPDATE checkins SET used_at = ? WHERE fan_id = ? AND used_at IS NULL").run(new Date().toISOString(), fan.id);
    db.prepare("INSERT INTO checkins (id, fan_id, code_hash, expires_at, used_at, gig_id) VALUES (?, ?, ?, ?, NULL, NULL)")
      .run(id, fan.id, sha(raw), new Date(Date.now() + ttl).toISOString());
    const qr = await QRCode.toDataURL(raw, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 280,
      color: { dark: "#102e32", light: "#f3f1ea" },
    });
    return { id, code: raw, expiresAt: new Date(Date.now() + ttl).toISOString(), qr };
  }

  function checkinStatus(token, id) {
    const fan = requireVerifiedFan(token);
    const row = db.prepare("SELECT * FROM checkins WHERE id = ? AND fan_id = ?").get(id, fan.id);
    if (!row) throw fail(404, "That code was not found.");
    if (row.used_at && row.gig_id) {
      const gig = db.prepare("SELECT name, image, starts_at FROM gigs WHERE id = ?").get(row.gig_id);
      return { status: "registered", gigName: gig?.name ?? "", image: gig?.image ? `/media/${gig.image}` : null, startsAt: gig?.starts_at ?? null };
    }
    if (new Date(row.expires_at).getTime() < Date.now()) return { status: "expired" };
    return { status: "pending" };
  }

  function fanGigs(token) {
    const fan = requireVerifiedFan(token);
    const rows = db.prepare(`SELECT g.id, g.name, g.starts_at, g.bio, g.tour_name, g.image, r.registered_at
      FROM registrations r JOIN gigs g ON g.id = r.gig_id
      WHERE r.fan_id = ? ORDER BY g.starts_at DESC`).all(fan.id);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      startsAt: row.starts_at,
      bio: row.bio || "",
      tourName: row.tour_name || "",
      image: row.image ? `/media/${row.image}` : null,
      registeredAt: row.registered_at,
      members: members(row.id),
    }));
  }

  async function fanCodes(token) {
    const fan = requireVerifiedFan(token);
    const rows = db.prepare(`SELECT c.id, c.label, c.code, c.in_person, c.message, c.expires_at, c.image, c.created_at, o.name, o.kind, o.profile_image
      FROM priority_codes c JOIN orgs o ON o.id = c.org_id
      WHERE c.fan_id = ? AND (c.expires_at IS NULL OR c.expires_at = '' OR c.expires_at > ?)
      ORDER BY c.created_at DESC`).all(fan.id, new Date().toISOString());
    const codes = [];
    for (const row of rows) {
      const inPerson = row.in_person === 1;
      const tile = row.image ? `/media/${row.image}` : (row.profile_image ? `/media/${row.profile_image}` : null);
      codes.push({
        id: row.id,
        label: row.label,
        message: row.message || "",
        expiresAt: row.expires_at || null,
        code: row.code,
        inPerson,
        qr: inPerson ? await QRCode.toDataURL(row.code, {
          errorCorrectionLevel: "M",
          margin: 0,
          width: 280,
          color: { dark: "#102e32", light: "#f3f1ea" },
        }) : null,
        createdAt: row.created_at,
        orgName: row.name,
        orgKind: row.kind,
        profileImage: tile,
      });
    }
    return codes;
  }

  function updateOrg(token, body) {
    const org = requireVerifiedOrg(token);
    const name = body.name === undefined ? org.name : String(body.name).trim();
    if (!name) throw fail(400, "Enter a name.");
    const kinds = ["band", "team", "ensemble", "organiser", "venue", "festival"];
    const kind = body.kind === undefined ? org.kind : String(body.kind);
    if (!kinds.includes(kind)) throw fail(400, "Choose what kind of account this is.");
    let image = org.profile_image;
    if (body.profileImage) image = saveImage(body.profileImage);
    let passwordHash = org.password_hash;
    if (body.password) {
      assertPassword(body.password);
      passwordHash = hashPassword(String(body.password));
    }
    db.prepare("UPDATE orgs SET name = ?, kind = ?, profile_image = ?, password_hash = ? WHERE id = ?").run(name, kind, image, passwordHash, org.id);
    return publicOrg(db.prepare("SELECT * FROM orgs WHERE id = ?").get(org.id));
  }

  function newJoinCode(token) {
    const org = requireVerifiedOrg(token);
    db.prepare("DELETE FROM join_codes WHERE org_id = ? AND used_at IS NULL").run(org.id);
    const join = code(6);
    const expiresAt = new Date(Date.now() + 45_000).toISOString();
    db.prepare("INSERT INTO join_codes (code, org_id, used_at, expires_at) VALUES (?, ?, NULL, ?)").run(join, org.id, expiresAt);
    return { code: join, expiresAt };
  }

  function listGigs(token) {
    const org = requireVerifiedOrg(token);
    const rows = db.prepare(`SELECT g.* FROM gigs g
      JOIN gig_orgs s ON s.gig_id = g.id
      WHERE s.org_id = ? ORDER BY coalesce(g.starts_at, g.created_at) DESC`).all(org.id);
    return rows.map((gig) => gigView(gig));
  }

  function createGig(token, body = {}) {
    const org = requireVerifiedOrg(token);
    const id = randomUUID();
    let eventCode = code(6);
    while (db.prepare("SELECT id FROM gigs WHERE event_code = ?").get(eventCode)) eventCode = code(6);
    const role = orgRole(org.kind);
    let image = null;
    if (body.image) image = saveImage(body.image);
    else if (body.copyFrom) {
      const source = assertOnGig(org.id, String(body.copyFrom));
      image = source.image;
    }
    const name = String(body.name ?? "").trim() || null;
    const bio = String(body.bio ?? "").trim();
    const tourName = optionalPlace(body.tourName);
    const city = optionalPlace(body.city);
    const country = optionalPlace(body.country);
    let starts = null;
    if (body.date) starts = eventStart(body.date, body.time);
    db.exec("BEGIN");
    try {
      db.prepare(`INSERT INTO gigs (id, event_code, event_password, creator_org_id, name, starts_at, bio, image, tour_name, city, country, live, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(id, eventCode, code(8), org.id, name, starts, bio, image, tourName, city, country, new Date().toISOString());
      db.prepare("INSERT INTO gig_orgs (gig_id, org_id, role) VALUES (?, ?, ?)").run(id, org.id, role);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return gigView(db.prepare("SELECT * FROM gigs WHERE id = ?").get(id));
  }

  function eventStart(dateValue, timeValue) {
    const date = String(dateValue ?? "").trim();
    const time = String(timeValue ?? "").trim() || "00:00";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail(400, "Enter the date of the event.");
    const parsed = new Date(`${date}T${time}`);
    if (Number.isNaN(parsed.getTime())) throw fail(400, "Enter a valid time.");
    return parsed.toISOString();
  }

  function updateGig(token, gigId, body) {
    const org = requireVerifiedOrg(token);
    const gig = assertOnGig(org.id, gigId);
    const name = body.name === undefined ? gig.name : String(body.name).trim();
    const bio = body.bio === undefined ? gig.bio : String(body.bio ?? "").trim();
    const tourName = body.tourName === undefined ? gig.tour_name : optionalPlace(body.tourName);
    const city = body.city === undefined ? gig.city : optionalPlace(body.city);
    const country = body.country === undefined ? gig.country : optionalPlace(body.country);
    let starts = gig.starts_at;
    if (body.date || body.time) starts = eventStart(body.date, body.time);
    let image = gig.image;
    if (body.image) image = saveImage(body.image);
    if (body.name !== undefined && !name) throw fail(400, "Enter the name of the event.");
    db.prepare("UPDATE gigs SET name = ?, starts_at = ?, bio = ?, image = ?, tour_name = ?, city = ?, country = ? WHERE id = ?")
      .run(name || null, starts, bio ?? "", image, tourName, city, country, gig.id);
    return gigView(db.prepare("SELECT * FROM gigs WHERE id = ?").get(gig.id));
  }

  function goLive(token, gigId) {
    const org = requireVerifiedOrg(token);
    const gig = assertOnGig(org.id, gigId);
    if (!gigReady(gig)) throw fail(409, "Add a name, date, and image before this event can go live.");
    if (gig.live !== 1) db.prepare("UPDATE gigs SET live = 1 WHERE id = ?").run(gig.id);
    return gigView(db.prepare("SELECT * FROM gigs WHERE id = ?").get(gig.id));
  }

  async function scannerCode(token, gigId) {
    const org = requireVerifiedOrg(token);
    const gig = assertOnGig(org.id, gigId);
    if (gig.live !== 1) throw fail(409, "This event is not live yet.");
    db.prepare("DELETE FROM scanner_codes WHERE gig_id = ? AND used_at IS NULL").run(gig.id);
    let value = code(8);
    while (db.prepare("SELECT code FROM scanner_codes WHERE code = ?").get(value)) value = code(8);
    db.prepare("INSERT INTO scanner_codes (code, gig_id, used_at) VALUES (?, ?, NULL)").run(value, gig.id);
    return { code: value, qr: await scannerQr(value) };
  }

  function deleteGig(token, gigId) {
    const org = requireVerifiedOrg(token);
    const gig = assertOnGig(org.id, gigId);
    if (gig.starts_at && gig.live === 1) throw fail(409, "A live event with a date cannot be deleted.");
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM sessions WHERE actor = 'receiver' AND actor_id = ?").run(gig.id);
      db.prepare("DELETE FROM scanner_codes WHERE gig_id = ?").run(gig.id);
      db.prepare("DELETE FROM checkins WHERE gig_id = ?").run(gig.id);
      db.prepare("DELETE FROM registrations WHERE gig_id = ?").run(gig.id);
      db.prepare("DELETE FROM gig_orgs WHERE gig_id = ?").run(gig.id);
      db.prepare("DELETE FROM gigs WHERE id = ?").run(gig.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { ok: true };
  }

  function getGig(token, gigId) {
    const org = requireVerifiedOrg(token);
    return gigView(assertOnGig(org.id, gigId));
  }

  function addMember(token, gigId, body, slot) {
    const org = requireVerifiedOrg(token);
    assertOnGig(org.id, gigId);
    const join = String(body.code ?? "").trim().toUpperCase();
    const row = db.prepare("SELECT * FROM join_codes WHERE code = ?").get(join);
    if (!row || row.used_at) throw fail(400, "That code has already been used.");
    if (!row.expires_at || new Date(row.expires_at).getTime() <= Date.now()) throw fail(400, "That code has expired.");
    const other = db.prepare("SELECT * FROM orgs WHERE id = ?").get(row.org_id);
    if (!other) throw fail(400, "That code was not found.");
    const resolved = slot === "member" ? orgRole(other.kind) : slot;
    if (resolved === "act" && !["band", "team", "ensemble"].includes(other.kind)) throw fail(400, "That code is not from a band, team, or ensemble.");
    if (resolved === "venue" && other.kind !== "venue") throw fail(400, "That code is not from a venue.");
    const existing = db.prepare("SELECT org_id FROM gig_orgs WHERE gig_id = ? AND org_id = ?").get(gigId, other.id);
    if (existing) throw fail(400, "They are already on this event.");
    if (resolved === "venue") {
      const venue = db.prepare("SELECT org_id FROM gig_orgs WHERE gig_id = ? AND role = 'venue'").get(gigId);
      if (venue) throw fail(400, "This event already has a venue.");
    }
    db.prepare("UPDATE join_codes SET used_at = ? WHERE code = ?").run(new Date().toISOString(), join);
    db.prepare("INSERT INTO gig_orgs (gig_id, org_id, role) VALUES (?, ?, ?)").run(gigId, other.id, resolved);
    return gigView(db.prepare("SELECT * FROM gigs WHERE id = ?").get(gigId));
  }

  function groupPreview(token, url) {
    const org = requireVerifiedOrg(token);
    const group = url.searchParams.get("group") || "everyone";
    const fans = fansFor(org, { group, gigId: url.searchParams.get("gigId") || "", place: url.searchParams.get("place") || "" });
    return { count: fans.length, fans: fans.map((fan) => ({ id: fan.id, username: fan.username })), tourName: group === "tour" ? lastTourName(org.id) : null };
  }

  function fansForSend(org, body) {
    if (Array.isArray(body.groups) && body.groups.length) {
      const found = new Map();
      for (const group of body.groups) {
        const type = String(group?.type ?? "");
        let rows = [];
        if (type === "all") rows = fansFor(org, { group: "everyone" });
        else if (type === "events") rows = [].concat(...(group.gigIds || []).map((gigId) => fansFor(org, { group: "gig", gigId })));
        else if (type === "tours") rows = [].concat(...(group.tours || []).map((tourName) => fansFor(org, { group: "tour", tourName })));
        else if (type === "places") rows = [].concat(...(group.names || []).map((place) => fansFor(org, { group: "place", place })));
        else throw fail(400, "Choose a group.");
        for (const fan of rows) found.set(fan.id, fan);
      }
      return [...found.values()];
    }
    return fansFor(org, body);
  }

  function sendCodes(token, body) {
    const org = requireVerifiedOrg(token);
    if (!org.profile_image && !body.image) throw fail(400, "Add a picture for this code.");
    const label = String(body.label ?? "").trim();
    if (!label) throw fail(400, "Name this code.");
    const message = String(body.message ?? "").trim();
    let expiresAt = String(body.expiresAt ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) expiresAt = `${expiresAt}T23:59:59.999Z`;
    if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) throw fail(400, "Enter the date this code expires.");
    const fans = fansForSend(org, body);
    if (!fans.length) throw fail(400, "Nobody in that group can receive a code yet.");
    const image = body.image ? saveImage(body.image) : null;
    const batch = randomUUID();
    const sent = [];
    db.exec("BEGIN");
    try {
      for (const fan of fans) {
        let value = code(8);
        while (db.prepare("SELECT id FROM priority_codes WHERE code = ?").get(value)) value = code(8);
        db.prepare(`INSERT INTO priority_codes (id, org_id, fan_id, label, code, in_person, message, expires_at, image, batch_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          randomUUID(), org.id, fan.id, label, value, body.inPerson ? 1 : 0, message, expiresAt || null, image, batch, new Date().toISOString(),
        );
        sent.push({ fanId: fan.id, username: fan.username });
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { count: sent.length, batch };
  }

  function issuedCodes(token) {
    const org = requireVerifiedOrg(token);
    const rows = db.prepare(`SELECT coalesce(batch_id, id) AS batch, label, message, in_person, expires_at, image, min(created_at) AS created_at, count(*) AS count
      FROM priority_codes WHERE org_id = ? GROUP BY coalesce(batch_id, id) ORDER BY created_at DESC`).all(org.id);
    return rows.map((row) => ({
      id: row.batch,
      label: row.label,
      message: row.message || "",
      inPerson: row.in_person === 1,
      expiresAt: row.expires_at,
      image: row.image ? `/media/${row.image}` : (org.profile_image ? `/media/${org.profile_image}` : null),
      createdAt: row.created_at,
      count: row.count,
    }));
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

  function receiverLogin(body) {
    const raw = String(body.code ?? body.eventCode ?? "").trim();
    const packed = raw.match(/^ticketid:([A-Za-z0-9]+)$/i);
    const value = (packed ? packed[1] : raw).toUpperCase();
    const row = value ? db.prepare("SELECT * FROM scanner_codes WHERE code = ?").get(value) : null;
    if (!row) throw fail(401, "That scanner code was not found.");
    if (row.used_at) throw fail(401, "That scanner code has already been used.");
    const gig = db.prepare("SELECT * FROM gigs WHERE id = ?").get(row.gig_id);
    if (!gig || gig.live !== 1) throw fail(409, "This event is not live yet.");
    if (!gigReady(gig)) throw fail(409, "Add a name, date, and image before check-in.");
    db.prepare("UPDATE scanner_codes SET used_at = ? WHERE code = ?").run(new Date().toISOString(), value);
    return { token: openSession("receiver", gig.id), image: `/media/${gig.image}`, name: gig.name };
  }

  function receiverEvent(token) {
    const session = sessionFor(token, "receiver");
    const gig = db.prepare("SELECT * FROM gigs WHERE id = ?").get(session.actor_id);
    if (!gig || !gig.image) throw fail(401, "Sign in to the event again.");
    return { image: `/media/${gig.image}`, name: gig.name };
  }

  function scan(token, body) {
    const session = sessionFor(token, "receiver");
    const gig = db.prepare("SELECT * FROM gigs WHERE id = ?").get(session.actor_id);
    if (!gig || !gigReady(gig)) throw fail(409, "Check-in is not open for this event.");
    const raw = String(body.code ?? "").trim().toUpperCase();
    const row = db.prepare("SELECT * FROM checkins WHERE code_hash = ?").get(sha(raw));
    if (!row) throw fail(400, "That code was not found.");
    if (row.used_at) throw fail(400, "That code has already been used.");
    if (new Date(row.expires_at).getTime() < Date.now()) throw fail(400, "That code has expired.");
    const existing = db.prepare("SELECT id FROM registrations WHERE fan_id = ? AND gig_id = ?").get(row.fan_id, gig.id);
    db.prepare("UPDATE checkins SET used_at = ?, gig_id = ? WHERE id = ?").run(new Date().toISOString(), gig.id, row.id);
    if (!existing) {
      db.prepare("INSERT INTO registrations (id, fan_id, gig_id, registered_at) VALUES (?, ?, ?, ?)").run(randomUUID(), row.fan_id, gig.id, new Date().toISOString());
    }
    return { ok: true };
  }

  return function onRequest(request, response) {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    Promise.resolve()
      .then(async () => {
        const result = await handle(request, response, url);
        if (result !== undefined && !response.headersSent) sendJson(response, 200, result);
      })
      .catch((error) => {
        const status = error.status ?? 500;
        if (status >= 500) console.error(error);
        if (!response.headersSent) sendJson(response, status, { message: status >= 500 ? "Something went wrong." : error.message });
      });
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("That request could not be read."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

export function listen(db, dataDir, port = Number(process.env.PORT || 8787), host = "127.0.0.1") {
  const server = http.createServer(createApp(db, dataDir));
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

export function listenHttps(db, dataDir, port, host, tlsOptions) {
  const server = https.createServer(tlsOptions, createApp(db, dataDir));
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      resolve({ server, url: `https://127.0.0.1:${address.port}` });
    });
  });
}
