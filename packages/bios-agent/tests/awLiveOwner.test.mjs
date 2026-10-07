import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { initializeKnowledgeStore } from "../core/storage/index.ts";
import { bindProjectWorkspace } from "../core/projects/index.ts";
import { createProjectSandbox, writeDsc } from "./helpers/projectFixtures.mjs";
import { withSession } from "./helpers/piSessionHarness.mjs";
import { currentAutomationBootId } from "../extensions/automationState.ts";

test("F1: settling another live process must not label its pending reflection unrecovered", async () => {
	const sb = await createProjectSandbox("aw-live-owner-");
	const previous = {};
	let child;
	const receive = (kind) =>
		new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				reject(new Error(`Owner timeout: ${kind}`));
			}, 15000);
			const onMessage = (value) => {
				if (value.kind === kind) {
					cleanup();
					resolve(value);
				}
			};
			const onError = (error) => {
				cleanup();
				reject(error);
			};
			const cleanup = () => {
				clearTimeout(timeout);
				child.off("message", onMessage);
				child.off("error", onError);
			};
			child.on("message", onMessage);
			child.on("error", onError);
		});
	try {
		await initializeKnowledgeStore({ root: sb.root });
		await writeDsc(sb.workspaceA, "Sample.dsc", { platformName: "Synthetic" });
		const binding = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, workspacePath: sb.workspaceA });
		const target = { root: sb.root, projectId: binding.projectId, workspaceId: binding.workspaceId };
		const env = {
			BIOS_KNOWLEDGE_ROOT: sb.root,
			BIOS_AUTHORIZED_PROJECTS: binding.projectId,
			BIOS_AUTHORIZED_ROOTS: sb.workspaceA,
			BIOS_ENDPOINT: "allowed",
			BIOS_ENDPOINT_GRANT: "",
			BIOS_SELECTED_PROJECT_ID: "",
			BIOS_SELECTED_TASK_ID: "",
			BIOS_SELECTED_WORKSPACE_ID: "",
			BIOS_CONTEXT_ENABLED: "0",
			BIOS_AUTOMATION_ENABLED: "1",
			BIOS_AUTOMATION_BOOKKEEPING: "1",
			BIOS_AUTOMATION_INJECT: "1",
			BIOS_AUTOMATION_VERSION: "1",
		};
		for (const [key, value] of Object.entries(env)) {
			previous[key] = process.env[key];
			process.env[key] = value;
		}
		child = fork(fileURLToPath(new URL("./helpers/liveReflectionOwner.mjs", import.meta.url)), [], { execArgv: ["--experimental-transform-types"], windowsHide: true, stdio: ["ignore", "ignore", "inherit", "ipc"], env: { ...process.env, BIOS_TEST_REFLECTION_TARGET: JSON.stringify(target) } });
		const ready = await receive("ready");
		assert.notEqual(ready.bootId, currentAutomationBootId(), "positive control: two genuinely different live processes");
		await withSession(
			sb,
			env,
			() => ({ text: "Synthetic neutral response." }),
			async ({ session }) => {
				await session.prompt("排查 USB 启动问题，先不要改源码");
			},
		);
		const verification = receive("verified");
		child.send("verify");
		const { mark } = await verification;
		assert.equal(mark.unrecoveredAt, undefined, "a live owner answering IPC is not evidence of termination");
		assert.equal(mark.finished, false);
		assert.equal(mark.saved, false);
	} finally {
		if (child && child.exitCode === null) {
			const exit = new Promise((resolve) => child.once("exit", resolve));
			child.kill();
			await exit;
		}
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await sb.cleanup();
	}
});
