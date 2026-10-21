import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const schema = `
CREATE TABLE IF NOT EXISTS fans (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  hometown TEXT,
  city TEXT,
  country TEXT,
  registered_only INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  profile_image TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mail (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gigs (
  id TEXT PRIMARY KEY,
  event_code TEXT NOT NULL UNIQUE,
  event_password TEXT NOT NULL,
  creator_org_id TEXT NOT NULL,
  name TEXT,
  starts_at TEXT,
  bio TEXT,
  image TEXT,
  tour_name TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gig_orgs (
  gig_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (gig_id, org_id)
);
CREATE TABLE IF NOT EXISTS join_codes (
  code TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  used_at TEXT,
  expires_at TEXT
);
CREATE TABLE IF NOT EXISTS scanner_codes (
  code TEXT PRIMARY KEY,
  gig_id TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS checkins (
  id TEXT PRIMARY KEY,
  fan_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  gig_id TEXT
);
CREATE TABLE IF NOT EXISTS registrations (
  id TEXT PRIMARY KEY,
  fan_id TEXT NOT NULL,
  gig_id TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  UNIQUE (fan_id, gig_id)
);
CREATE TABLE IF NOT EXISTS priority_codes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  fan_id TEXT NOT NULL,
  label TEXT NOT NULL,
  code TEXT NOT NULL,
  in_person INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  fan_id TEXT NOT NULL,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
`;

export function openDatabase(dataDir) {
  fs.mkdirSync(path.join(dataDir, "media"), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "ticketid.db"));
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(schema);
  migrate(db);
  return db;
}

function migrate(db) {
  const names = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!names("fans").includes("country")) db.exec("ALTER TABLE fans ADD COLUMN country TEXT");
  db.exec("UPDATE fans SET city = hometown WHERE (city IS NULL OR trim(city) = '') AND hometown IS NOT NULL AND trim(hometown) != ''");
  if (!names("priority_codes").includes("in_person")) db.exec("ALTER TABLE priority_codes ADD COLUMN in_person INTEGER NOT NULL DEFAULT 0");
  if (!names("gigs").includes("city")) db.exec("ALTER TABLE gigs ADD COLUMN city TEXT");
  if (!names("gigs").includes("country")) db.exec("ALTER TABLE gigs ADD COLUMN country TEXT");
  if (!names("gigs").includes("live")) {
    db.exec("ALTER TABLE gigs ADD COLUMN live INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE gigs SET live = 1");
  }
  if (!names("priority_codes").includes("message")) db.exec("ALTER TABLE priority_codes ADD COLUMN message TEXT");
  if (!names("priority_codes").includes("expires_at")) db.exec("ALTER TABLE priority_codes ADD COLUMN expires_at TEXT");
  if (!names("priority_codes").includes("image")) db.exec("ALTER TABLE priority_codes ADD COLUMN image TEXT");
  if (!names("priority_codes").includes("batch_id")) db.exec("ALTER TABLE priority_codes ADD COLUMN batch_id TEXT");
  if (!names("join_codes").includes("expires_at")) db.exec("ALTER TABLE join_codes ADD COLUMN expires_at TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS scanner_codes (
    code TEXT PRIMARY KEY,
    gig_id TEXT NOT NULL,
    used_at TEXT
  )`);
}
