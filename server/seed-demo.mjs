import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "./db.js";

const mediaDir = path.resolve("data/media");
fs.mkdirSync(mediaDir, { recursive: true });

const photos = {
  roundhouse: "https://upload.wikimedia.org/wikipedia/commons/4/46/The_Roundhouse%2C_Camden_-_geograph.org.uk_-_541283.jpg",
  brixton: "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b0/Brixton_Academy_Flaming_Lips_concert.jpg/960px-Brixton_Academy_Flaming_Lips_concert.jpg",
  alexandra: "https://upload.wikimedia.org/wikipedia/commons/thumb/8/84/Suede_concert_at_Alexandra_Palace%2C_London_%288606558961%29.jpg/960px-Suede_concert_at_Alexandra_Palace%2C_London_%288606558961%29.jpg",
  albert: "https://upload.wikimedia.org/wikipedia/commons/thumb/e/ed/Royal_Albert_Hall_-_Central_View_169.jpg/960px-Royal_Albert_Hall_-_Central_View_169.jpg",
  wembley: "https://upload.wikimedia.org/wikipedia/commons/thumb/7/71/BTS_in_concert_at_Wembley_Stadium%2C_2_June_2019_01.jpg/960px-BTS_in_concert_at_Wembley_Stadium%2C_2_June_2019_01.jpg",
  glastonbury: "https://upload.wikimedia.org/wikipedia/commons/thumb/e/ef/The_Other_Stage_-_Glastonbury_2019.jpg/960px-The_Other_Stage_-_Glastonbury_2019.jpg",
  barrowland: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Wfm_barrowland_ballroom.jpg/960px-Wfm_barrowland_ballroom.jpg",
  apollo: "https://upload.wikimedia.org/wikipedia/commons/thumb/6/62/Hammersmith_Apollo_02.JPG/960px-Hammersmith_Apollo_02.JPG",
  o2: "https://upload.wikimedia.org/wikipedia/commons/thumb/6/69/O2_Arena.jpg/960px-O2_Arena.jpg",
  primavera: "https://upload.wikimedia.org/wikipedia/commons/thumb/2/2c/Primavera_Sound_Lotus_stage.jpg/960px-Primavera_Sound_Lotus_stage.jpg",
  emirates: "https://commons.wikimedia.org/wiki/Special:FilePath/Emirates_Stadium_behind_the_goal.jpg?width=960",
  mudder: "https://commons.wikimedia.org/wiki/Special:FilePath/Tough_Mudder_obstacle_Everest.jpg?width=960",
};

async function download(name, url) {
  const existing = fs.readdirSync(mediaDir).find((file) => file.startsWith(`demo-${name}.`));
  if (existing && fs.statSync(path.join(mediaDir, existing)).size > 1000) return existing;
  let response;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(url, { headers: { "user-agent": "ticketID-local/1.0 (personal demo; contact local)" } });
    if (response.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
  }
  if (!response.ok) throw new Error(`Could not fetch ${name}: ${response.status}`);
  const type = response.headers.get("content-type") || "";
  const ext = type.includes("png") ? "png" : "jpg";
  const filename = `demo-${name}.${ext}`;
  fs.writeFileSync(path.join(mediaDir, filename), Buffer.from(await response.arrayBuffer()));
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return filename;
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 32).toString("hex")}`;
}

function code(length) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  let out = "";
  for (let index = 0; index < length; index += 1) out += alphabet[bytes[index] % alphabet.length];
  return out;
}

const files = {};
for (const [name, url] of Object.entries(photos)) files[name] = await download(name, url);

const db = openDatabase(path.resolve("data"));
const email = "alex@ticketid.test";
const existing = db.prepare("SELECT id FROM fans WHERE email = ?").get(email);
if (existing) {
  db.prepare("DELETE FROM priority_codes WHERE fan_id = ?").run(existing.id);
  db.prepare("DELETE FROM registrations WHERE fan_id = ?").run(existing.id);
  db.prepare("DELETE FROM sessions WHERE actor = 'fan' AND actor_id = ?").run(existing.id);
  db.prepare("DELETE FROM fans WHERE id = ?").run(existing.id);
}

const oldEvents = db.prepare("SELECT id FROM gigs WHERE image LIKE 'demo-%'").all();
for (const row of oldEvents) {
  db.prepare("DELETE FROM registrations WHERE gig_id = ?").run(row.id);
  db.prepare("DELETE FROM gig_orgs WHERE gig_id = ?").run(row.id);
  db.prepare("DELETE FROM checkins WHERE gig_id = ?").run(row.id);
  db.prepare("DELETE FROM sessions WHERE actor = 'receiver' AND actor_id = ?").run(row.id);
  db.prepare("DELETE FROM gigs WHERE id = ?").run(row.id);
}

const fanId = randomUUID();
db.prepare(`INSERT INTO fans (id, username, email, phone, password_hash, hometown, city, country, registered_only, verified, created_at)
  VALUES (?, 'alex', ?, '07700900456', ?, NULL, 'London', 'United Kingdom', 0, 1, ?)`).run(fanId, email, hashPassword("password1"), new Date().toISOString());

const acts = [
  ["Radiohead", "band", "roundhouse"],
  ["Pulp", "band", "brixton"],
  ["Suede", "band", "alexandra"],
  ["London Symphony Orchestra", "ensemble", "albert"],
  ["Arsenal", "team", "emirates"],
  ["Blur", "band", "wembley"],
  ["Florence and the Machine", "band", "glastonbury"],
  ["Arctic Monkeys", "band", "apollo"],
  ["IDLES", "band", "o2"],
];
const places = [
  ["The Roundhouse", "venue", "roundhouse"],
  ["Brixton Academy", "venue", "brixton"],
  ["Alexandra Palace", "venue", "alexandra"],
  ["Royal Albert Hall", "venue", "albert"],
  ["Emirates Stadium", "venue", "emirates"],
  ["Wembley Stadium", "venue", "wembley"],
  ["Glastonbury", "festival", "glastonbury"],
  ["Tough Mudder", "organiser", "mudder"],
  ["Hammersmith Apollo", "venue", "apollo"],
  ["The O2", "venue", "o2"],
  ["Primavera Sound", "festival", "primavera"],
];

function org(name, kind, photo) {
  const found = db.prepare("SELECT id FROM orgs WHERE name = ? AND kind = ?").get(name, kind);
  if (found) {
    db.prepare("UPDATE orgs SET profile_image = ?, verified = 1 WHERE id = ?").run(files[photo], found.id);
    return found.id;
  }
  const id = randomUUID();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  db.prepare(`INSERT INTO orgs (id, kind, name, email, password_hash, profile_image, verified, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(id, kind, name, `${slug}@ticketid.test`, hashPassword("password1"), files[photo], new Date().toISOString());
  return id;
}

const actIds = Object.fromEntries(acts.map(([name, kind, photo]) => [name, org(name, kind, photo)]));
const placeIds = Object.fromEntries(places.map(([name, kind, photo]) => [name, org(name, kind, photo)]));

const gigs = [
  ["Radiohead at the Roundhouse", "Radiohead", "The Roundhouse", "roundhouse", "2024-06-18T19:30:00.000Z", "A Moon Shaped Pool", "London", "United Kingdom"],
  ["Pulp at Brixton Academy", "Pulp", "Brixton Academy", "brixton", "2026-03-14T19:00:00.000Z", "Different Class", "London", "United Kingdom"],
  ["Suede at Alexandra Palace", "Suede", "Alexandra Palace", "alexandra", "2025-05-02T19:00:00.000Z", "Coming Up", "London", "United Kingdom"],
  ["London Symphony Orchestra at the Royal Albert Hall", "London Symphony Orchestra", "Royal Albert Hall", "albert", "2026-02-08T19:30:00.000Z", "Season", "London", "United Kingdom"],
  ["Arsenal at the Emirates Stadium", "Arsenal", "Emirates Stadium", "emirates", "2026-04-12T16:30:00.000Z", "Premier League", "London", "United Kingdom"],
  ["Blur at Wembley Stadium", "Blur", "Wembley Stadium", "wembley", "2024-07-20T17:00:00.000Z", "Parklife", "London", "United Kingdom"],
  ["Florence and the Machine at Glastonbury", "Florence and the Machine", "Glastonbury", "glastonbury", "2025-06-28T21:00:00.000Z", "Dance Fever", "Glastonbury", "United Kingdom"],
  ["Tough Mudder London", null, "Tough Mudder", "mudder", "2026-09-04T09:00:00.000Z", "London", "London", "United Kingdom"],
  ["Arctic Monkeys at Hammersmith Apollo", "Arctic Monkeys", "Hammersmith Apollo", "apollo", "2024-11-16T19:30:00.000Z", "AM", "London", "United Kingdom"],
  ["Primavera Sound", "IDLES", "Primavera Sound", "primavera", "2025-06-05T16:00:00.000Z", "A weekend in Barcelona", "Barcelona", "Spain"],
];

for (const [name, act, place, photo, starts, tour, city, country] of gigs) {
  const id = randomUUID();
  const venueId = placeIds[place];
  const creator = db.prepare("SELECT kind FROM orgs WHERE id = ?").get(venueId).kind === "venue" ? "venue" : "festival";
  db.prepare(`INSERT INTO gigs (id, event_code, event_password, creator_org_id, name, starts_at, bio, image, tour_name, city, country, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, code(6), code(8), venueId, name, starts, tour, files[photo], tour, city, country, new Date().toISOString());
  db.prepare("INSERT INTO gig_orgs (gig_id, org_id, role) VALUES (?, ?, ?)").run(id, venueId, creator);
  if (act) db.prepare("INSERT INTO gig_orgs (gig_id, org_id, role) VALUES (?, ?, 'act')").run(id, actIds[act]);
  db.prepare("INSERT INTO registrations (id, fan_id, gig_id, registered_at) VALUES (?, ?, ?, ?)").run(randomUUID(), fanId, id, starts);
}

const offers = [
  ["Radiohead", "Priority access", 0],
  ["London Symphony Orchestra", "Priority access", 0],
  ["Arsenal", "Priority access", 0],
  ["Brixton Academy", "Free drink", 1],
  ["Tough Mudder", "Priority access", 0],
];
for (const [name, label, inPerson] of offers) {
  const sender = actIds[name] || placeIds[name];
  db.prepare("INSERT INTO priority_codes (id, org_id, fan_id, label, code, in_person, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), sender, fanId, label, code(8), inPerson, new Date().toISOString());
}
db.close();
console.log("alex@ticketid.test password1");
