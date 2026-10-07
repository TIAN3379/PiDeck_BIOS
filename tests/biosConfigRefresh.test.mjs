import { test } from "node:test";
import assert from "node:assert/strict";
import { BiosKnowledgeService } from "../src/main/bios/BiosKnowledgeService.ts";
import { BIOS_SETTINGS_DEFAULTS } from "../src/shared/types/bios.ts";

function fixture(settings = BIOS_SETTINGS_DEFAULTS, stopped = true) {
	const calls = [];
	const resolution = { agentId: "refresh-agent", sessionId: "refresh-session", cwd: process.cwd(), generation: 1 };
	const service = new BiosKnowledgeService({
		readSettings: () => settings,
		session: {
			resolve: () => ({ resolution }),
			listSessions: () => [resolution],
			revokeAuthority: () => calls.push("revoke"),
			stopRuntime: async () => {
				calls.push("stop");
				return { stopped, error: stopped ? null : "stop failed" };
			},
			pushContextOff: async () => ({ receipt: "off" }),
			syncSelection: async () => ({ error: "not used" }),
		},
	});
	return { service, calls };
}

test("UX-02: 首次配置或放宽也停止旧环境快照，并先撤销发送许可", async () => {
	for (const patch of [{ knowledgeRoot: process.cwd() }, { endpoint: "allowed" }, { authorizedProjectIds: ["sample"] }, { allowedFeatureIds: ["feature"] }, { approvedCustomers: ["customer"] }, { authorizedRoots: [process.cwd()] }]) {
		const { service, calls } = fixture();
		const result = await service.updateSettings(patch);
		assert.deepEqual(result.invalidated, ["refresh-agent@1"], JSON.stringify(patch));
		assert.deepEqual(calls, ["revoke", "stop"]);
		assert.equal(result.runtime.pendingRestart, true);
	}
});

test("UX-02: 相同配置或仅集合顺序变化不打断会话", async () => {
	const settings = { ...BIOS_SETTINGS_DEFAULTS, authorizedProjectIds: ["a", "b"] };
	for (const patch of [{}, { authorizedProjectIds: ["b", "a"] }]) {
		const { service, calls } = fixture(settings);
		assert.deepEqual((await service.updateSettings(patch)).invalidated, []);
		assert.deepEqual(calls, []);
	}
});

test("UX-02: 放宽时停止失败仍阻断旧代次读取并报告失败", async () => {
	const { service, calls } = fixture(BIOS_SETTINGS_DEFAULTS, false);
	const result = await service.updateSettings({ endpoint: "allowed" });
	assert.deepEqual(calls, ["revoke", "stop"]);
	assert.deepEqual(result.stopFailed, ["refresh-agent"]);
	assert.equal(result.runtime.pendingRestart, true);
	const listed = await service.listProjects({ sessionRef: { agentId: "refresh-agent", sessionId: "refresh-session" }, runtimeGeneration: 1 });
	assert.deepEqual(listed.items, []);
	assert.ok(listed.gap);
});
