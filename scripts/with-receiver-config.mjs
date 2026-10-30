import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(root, "capacitor.config.json");
const original = fs.readFileSync(configPath, "utf8");
const alternate = fs.readFileSync(path.join(root, process.argv[2]), "utf8");
const command = process.argv.slice(3).join(" ");

try {
  fs.writeFileSync(configPath, alternate);
  const result = spawnSync(command, { cwd: root, stdio: "inherit", shell: true });
  process.exitCode = result.status ?? 1;
} finally {
  fs.writeFileSync(configPath, original);
}
