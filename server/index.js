import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db.js";
import { listen, listenHttps } from "./http.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR || path.join(root, "data");
const db = openDatabase(dataDir);
const { url } = await listen(db, dataDir, Number(process.env.PORT || 8787), "0.0.0.0");
const port = new URL(url).port;
const local = `http://127.0.0.1:${port}`;
console.log(`ticketID is running at ${local}`);
console.log(`Fan app: ${local}/`);
console.log(`Receiver: ${local}/receiver/`);
console.log(`Dashboard: ${local}/dashboard/`);
const addresses = [];
for (const entries of Object.values(os.networkInterfaces())) {
  for (const entry of entries || []) {
    if (entry.family !== "IPv4" || entry.internal || entry.address.startsWith("169.254.")) continue;
    addresses.push(entry.address);
  }
}
if (addresses.length) console.log(`On your phone (same Wi-Fi): ${addresses.map((address) => `http://${address}:${port}/`).join(" ")}`);
const certificate = path.join(dataDir, "dev-https.pfx");
if (fs.existsSync(certificate)) {
  const securePort = Number(process.env.HTTPS_PORT || 8443);
  const secure = await listenHttps(db, dataDir, securePort, "0.0.0.0", {
    pfx: fs.readFileSync(certificate),
    passphrase: "ticketid",
  });
  const secureHost = addresses[0] || "127.0.0.1";
  console.log(`Phones (camera): ${secure.url.replace("127.0.0.1", secureHost)}/`);
  console.log(`Fan app: https://${secureHost}:${new URL(secure.url).port}/`);
  console.log(`Receiver: https://${secureHost}:${new URL(secure.url).port}/receiver/`);
}
if (process.env.NODE_ENV !== "production") console.log(`Data: ${dataDir === path.join(root, "data") ? dataDir : path.relative(os.homedir(), dataDir)}`);
