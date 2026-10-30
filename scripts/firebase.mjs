import { spawn } from "node:child_process";
import { emulatorEnv } from "./emulator-env.mjs";

const child = spawn(
  "npx firebase emulators:start --project demo-ticketid",
  { shell: true, stdio: "inherit", env: emulatorEnv() },
);
child.on("exit", (code) => process.exit(code ?? 1));
