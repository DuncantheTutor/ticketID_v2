import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = process.argv[2] || "android";
const built = path.join(root, project, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const dest = path.join(root, "dist", process.argv[3] || "ticketID.apk");
if (!fs.existsSync(built)) {
  console.error(`No APK at ${built}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(built, dest);
console.log(`Installable app: ${dest}`);
