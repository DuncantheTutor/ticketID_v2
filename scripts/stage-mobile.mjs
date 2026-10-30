import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = ["receiver", "dashboard"].includes(process.argv[2]) ? process.argv[2] : "fan";
const from = path.join(root, "public");
const to = path.join(root, "mobile", target === "fan" ? "www" : target);
const hosted = "https://ticketid-ab43c.web.app";

fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(path.dirname(to), { recursive: true });
fs.cpSync(from, to, { recursive: true });
fs.copyFileSync(path.join(from, target, "index.html"), path.join(to, "index.html"));

const address = (process.env.TICKETID_SERVER || hosted).replace(/\/$/, "");
fs.writeFileSync(path.join(to, "config.js"), `window.TICKETID_SERVER = ${JSON.stringify(address)};\n`);
console.log(`ticketID app server: ${address}`);
