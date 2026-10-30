import { spawn } from "node:child_process";
import { emulatorEnv } from "./emulator-env.mjs";

const child = spawn(
  "npx firebase emulators:exec --only auth,firestore,storage --project demo-ticketid \"node --test functions/api.test.mjs\"",
  { shell: true, stdio: "inherit", env: emulatorEnv() },
);
child.on("exit", (code) => process.exit(code ?? 1));
