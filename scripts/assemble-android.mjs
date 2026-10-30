import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const android = path.join(root, process.argv[2] || "android");
const gradle = findGradle() || path.join(android, "gradlew.bat");
console.log(`Using ${gradle}`);
const result = process.platform === "win32"
  ? spawnSync(`"${gradle}" assembleDebug`, { cwd: android, stdio: "inherit", shell: true })
  : spawnSync(gradle, ["assembleDebug"], { cwd: android, stdio: "inherit" });
if (result.error) console.error(result.error.message);
if (result.status !== 0) process.exit(result.status ?? 1);

function findGradle() {
  const dists = path.join(os.homedir(), ".gradle", "wrapper", "dists");
  if (!fs.existsSync(dists)) return "";
  const hits = [];
  for (const entry of fs.readdirSync(dists)) {
    if (!entry.startsWith("gradle-8.")) continue;
    walk(path.join(dists, entry), hits);
  }
  return hits.sort().at(-1) || "";
}

function walk(dir, hits) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(next, hits);
    else if (entry.name === "gradle.bat") hits.push(next);
  }
}
