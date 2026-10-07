/** Launch a fresh isolated directory package with a localhost-only synthetic provider. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { seedBiosGui } from "./biosGuiSeed.mjs";
import { startTestProvider } from "../packages/bios-agent/tests/helpers/piSessionHarness.mjs";

const executable = resolve(process.argv[2] ?? "");
const base = resolve(process.argv[3] ?? "");
if (!executable.endsWith(".exe") || !existsSync(executable) || !process.argv[3]) throw new Error("Provide packaged executable and NEW synthetic profile directory.");
const provider = await startTestProvider(() => ({ text: "SYNTHETIC-OFFLINE-ACK: no real model or board used." }));
const seeded = await seedBiosGui(base, provider.port);
const env = { ...process.env, PIDECK_E2E: "1", PIDECK_E2E_USER_DATA_DIR: seeded.profile, PI_CODING_AGENT_DIR: seeded.agentDir, USERPROFILE: base, APPDATA: join(base, "AppData", "Roaming"), LOCALAPPDATA: join(base, "AppData", "Local"), ELECTRON_RUN_AS_NODE: "" };
delete env.ELECTRON_RENDERER_URL;
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [`--user-data-dir=${seeded.profile}`], { env, stdio: "ignore", windowsHide: true });
console.log(JSON.stringify({ ...seeded, pid: child.pid, provider: `127.0.0.1:${provider.port}`, executable }));
child.on("exit", async (code) => {
	console.log(JSON.stringify({ exitCode: code, syntheticProviderRequests: provider.requests.length }));
	await provider.close();
});
child.on("error", async (error) => {
	console.error(error.message);
	await provider.close();
	process.exitCode = 1;
});
