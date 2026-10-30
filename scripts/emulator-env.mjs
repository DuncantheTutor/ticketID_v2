import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function emulatorEnv(base = process.env) {
  const env = { ...base };
  const root = path.join(os.homedir(), ".jdks");
  const found = existsSync(root)
    ? readdirSync(root).find((name) => /^jdk-(2[1-9]|[3-9]\d)/.test(name))
    : "";
  const home = found ? path.join(root, found) : env.JAVA_HOME;
  if (home) {
    env.JAVA_HOME = home;
    const bin = path.join(home, "bin");
    env.Path = `${bin}${path.delimiter}${env.Path || env.PATH || ""}`;
    env.PATH = env.Path;
  }
  if (!env.NODE_OPTIONS?.includes("--use-system-ca")) env.NODE_OPTIONS = `${env.NODE_OPTIONS || ""} --use-system-ca`.trim();
  return env;
}
