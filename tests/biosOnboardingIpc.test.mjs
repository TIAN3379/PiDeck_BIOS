import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

test("project disconnect IPC validates human confirmation, revision and config; cleans channels", async () => {
	const handlers = new Map();
	let writes = 0;
	let changes = 0;
	const { registerBiosOnboardingIpc } = loadTsCommonJs("src/main/ipc/biosOnboardingIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: (name) => handlers.delete(name) } },
			"../../shared/ipc": { ipcChannels: { biosConnections: "list", biosDisconnectProject: "disconnect", biosPrepareOnboarding: "prepare", biosCompleteOnboarding: "complete" } },
		},
	});
	const dispose = registerBiosOnboardingIpc({
		onboarding: {
			connections: async () => ({ revision: 1 }),
			disconnect: async (request) => {
				writes++;
				return request;
			},
		},
		appLogger: {},
		onChanged: () => changes++,
	});
	assert.deepEqual(await handlers.get("list")({}), { revision: 1 });
	const request = { projectId: "target", expectedRevision: 1, configurationVersion: 2, confirmed: true };
	for (const raw of [null, { ...request, confirmed: false }, { ...request, expectedRevision: -1 }, { ...request, configurationVersion: "2" }, { ...request, knowledgeRoot: "forged" }]) await assert.rejects(() => handlers.get("disconnect")({}, raw));
	assert.equal(writes, 0);
	assert.deepEqual(JSON.parse(JSON.stringify(await handlers.get("disconnect")({}, request))), request);
	assert.equal(writes, 1);
	assert.equal(changes, 1);
	dispose();
	assert.equal(handlers.size, 0);
});

test("UX-03 IPC: ignores forged identity/root/scope; requires explicit confirmation; cleans handlers", async () => {
	const handlers = new Map();
	const calls = [];
	let notified = 0;
	const channels = { biosPrepareOnboarding: "prepare", biosCompleteOnboarding: "complete" };
	const { registerBiosOnboardingIpc } = loadTsCommonJs("src/main/ipc/biosOnboardingIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (name, callback) => handlers.set(name, callback), removeHandler: (name) => handlers.delete(name) } },
			"../../shared/ipc": { ipcChannels: channels },
		},
	});
	const dispose = registerBiosOnboardingIpc({
		onboarding: {
			prepare: async (id) => {
				calls.push(id);
				return { token: "server-token" };
			},
			complete: async (request) => {
				calls.push(request);
				return { status: "partial", authorization: null, binding: null };
			},
		},
		appLogger: { info() {} },
		onChanged() {
			notified++;
		},
	});
	await handlers.get("prepare")({}, { desktopProjectId: "real-desktop", biosProjectId: "forged", knowledgeRoot: "forged", workspacePath: "forged" });
	assert.deepEqual(calls, ["real-desktop"]);
	for (const raw of [null, [], {}, { token: "server-token", confirmed: false }, { token: "server-token", confirmed: "true" }]) await assert.rejects(() => handlers.get("complete")({}, raw));
	assert.equal(calls.length, 1);
	// D4：渲染层**不能**直接写端点策略；伪造的 `endpoint` 必须被丢弃（只有显式布尔授权才生效）。
	await handlers.get("complete")({}, { token: "server-token", confirmed: true, displayName: " Edited ", biosProjectId: "forged", authorizedRoots: ["forged"], endpoint: "allowed" });
	assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), { token: "server-token", confirmed: true, displayName: "Edited" });
	assert.equal(notified, 1);

	// D4：端点外发授权只认显式布尔 true；未勾选（false/缺省）一律不改动当前策略。
	await handlers.get("complete")({}, { token: "server-token", confirmed: true, endpointConsent: true, endpoint: "denied" });
	assert.deepEqual(JSON.parse(JSON.stringify(calls[2])), { token: "server-token", confirmed: true, endpointConsent: true });
	await handlers.get("complete")({}, { token: "server-token", confirmed: true, endpointConsent: false });
	assert.deepEqual(JSON.parse(JSON.stringify(calls[3])), { token: "server-token", confirmed: true }, "未勾选时不得带上 endpointConsent");
	for (const raw of [
		{ token: "server-token", confirmed: true, endpointConsent: "yes" },
		{ token: "server-token", confirmed: true, endpointConsent: 1 },
	])
		await assert.rejects(() => handlers.get("complete")({}, raw), /endpointConsent/);
	assert.equal(calls.length, 4);
	dispose();
	assert.equal(handlers.size, 0);
});
