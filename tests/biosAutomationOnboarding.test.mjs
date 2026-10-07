/**
 * AW-01/AW-03：**一次合并接入 + 宿主自动化许可**的针对性测试。
 *
 * 覆盖：
 * 1. 未配置知识根时预览提议默认库（`rootAction = "create-default"`），确认时一次完成
 *    "写知识根 → 建默认库 → 授权 → 绑定 → 落自动化许可"；
 * 2. 未勾选自动化时保持旧行为（不写许可）；
 * 3. 自动化许可经 `normalizeBiosHostSettings` / `biosProcessEnv` / `applyBiosEnv` 注入子进程，
 *    并且总是显式写入（关闭时写 0，清掉继承来的旧许可）；
 * 4. 冲突/取消不扩大授权。
 *
 * 不读真实知识库或客户源码：全部使用系统临时目录下的合成工作区。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readRegistry } from "../packages/bios-agent/core/storage/index.ts";
import { writeDsc, createProjectSandbox } from "../packages/bios-agent/tests/helpers/projectFixtures.mjs";
import { BiosOnboardingService } from "../src/main/bios/BiosOnboardingService.ts";
import { BiosKnowledgeService } from "../src/main/bios/BiosKnowledgeService.ts";
import { BiosBusinessService } from "../src/main/bios/BiosBusinessService.ts";
import { BIOS_AUTOMATION_DEFAULTS, BIOS_SETTINGS_DEFAULTS } from "../src/shared/types/bios.ts";
import { applyBiosEnv, BIOS_CONFIG_ENV_KEYS, biosProcessEnv, normalizeBiosHostSettings } from "../src/main/bios/biosProcessEnv.ts";

async function fixture(extra = {}) {
	const sb = await createProjectSandbox("bios-aw-onboarding-");
	await writeDsc(sb.workspaceA, "Sample.dsc", { platformName: "Sample" });
	const defaultRoot = join(sb.base, "default-knowledge");
	const state = { settings: { ...BIOS_SETTINGS_DEFAULTS, knowledgeRoot: null }, path: sb.workspaceA, inits: 0, saves: 0 };
	const knowledge = new BiosKnowledgeService({ readSettings: () => state.settings });
	const business = new BiosBusinessService({ readSettings: () => state.settings, resolveDesktopProjectPath: () => state.path, readConfigurationVersion: () => knowledge.currentConfigurationVersion() });
	const service = new BiosOnboardingService({
		readSettings: () => state.settings,
		readConfigurationVersion: () => knowledge.currentConfigurationVersion(),
		resolveProject: (id) => (id === "desktop-sample" ? { name: "Sample Board", path: state.path } : null),
		saveAuthorization: async (patch) => {
			const outcome = await knowledge.updateSettings(patch);
			state.settings = outcome.settings;
			state.saves += 1;
			return outcome;
		},
		bindProject: (request) => business.bindProject(request),
		resolveDefaultKnowledgeRoot: () => defaultRoot,
		initializeStore: async ({ knowledgeRoot }) => {
			state.inits += 1;
			try {
				const envelope = await business.initialize({ knowledgeRoot });
				return { ok: envelope.result.status === "existing" || envelope.committed, problem: null };
			} catch (error) {
				return { ok: false, problem: error instanceof Error ? error.message : String(error) };
			}
		},
		...extra,
	});
	return { ...sb, state, defaultRoot, service, cleanup: sb.cleanup };
}

test("AW-01：未配置知识根时一次确认完成建库 + 授权 + 绑定 + 自动化许可", async () => {
	const f = await fixture();
	try {
		const preview = await f.service.prepare("desktop-sample");
		assert.equal(preview.rootAction, "create-default");
		assert.equal(preview.knowledgeRoot, f.defaultRoot);
		assert.equal(preview.existing, false);
		// 预览本身不写库、不建目录。
		assert.equal(f.state.saves, 0);
		assert.equal(f.state.inits, 0);

		const outcome = await f.service.complete({ token: preview.token, confirmed: true, automation: { localBookkeeping: true, injectProjectData: true } });
		assert.equal(outcome.status, "completed", JSON.stringify(outcome.problem));
		assert.equal(f.state.inits, 1, "默认库应在这一次确认里被创建");
		assert.equal(f.state.settings.knowledgeRoot, f.defaultRoot);
		assert.equal(f.state.settings.automation.enabled, true);
		assert.equal(f.state.settings.automation.localBookkeeping, true);
		assert.equal(f.state.settings.automation.injectProjectData, true);
		assert.equal(f.state.settings.automation.version, 1, "首次授予的许可版本应为 1");
		assert.deepEqual(f.state.settings.authorizedProjectIds, [preview.biosProjectId]);
		assert.deepEqual(f.state.settings.authorizedRoots, [f.workspaceA]);
		// 权限没有被顺带扩大。
		assert.equal(f.state.settings.endpoint, "unknown");
		assert.deepEqual(f.state.settings.approvedCustomers, []);
		assert.deepEqual(f.state.settings.allowedFeatureIds, []);
		assert.equal((await readRegistry({ root: f.defaultRoot })).projects.length, 1);
	} finally {
		await f.cleanup();
	}
});

test("AW-01：未勾选自动化时保持旧行为（不写许可，仍完成接入）", async () => {
	const f = await fixture();
	try {
		const preview = await f.service.prepare("desktop-sample");
		const outcome = await f.service.complete({ token: preview.token, confirmed: true });
		assert.equal(outcome.status, "completed", JSON.stringify(outcome.problem));
		assert.deepEqual(f.state.settings.automation, BIOS_AUTOMATION_DEFAULTS);
	} finally {
		await f.cleanup();
	}
});

test("AW-01：用户取消时不建库、不授权、不写入任何许可", async () => {
	const f = await fixture();
	try {
		const preview = await f.service.prepare("desktop-sample");
		await assert.rejects(() => f.service.complete({ token: preview.token, confirmed: false, automation: { localBookkeeping: true, injectProjectData: true } }), /确认/);
		assert.equal(f.state.inits, 0);
		assert.equal(f.state.saves, 0);
		assert.equal(f.state.settings.knowledgeRoot, null);
	} finally {
		await f.cleanup();
	}
});

test("AW-03：自动化许可总是显式注入子进程 env；关闭时清掉继承来的旧许可", () => {
	// 归一化：缺省即拒绝；非法版本回落。
	assert.deepEqual(normalizeBiosHostSettings(null).automation, BIOS_AUTOMATION_DEFAULTS);
	assert.deepEqual(normalizeBiosHostSettings({ automation: { enabled: true, localBookkeeping: true, injectProjectData: false, version: 3 } }).automation, { enabled: true, localBookkeeping: true, injectProjectData: false, version: 3 });
	assert.equal(normalizeBiosHostSettings({ automation: { enabled: true, localBookkeeping: true, injectProjectData: true, version: 0 } }).automation.version, 1);
	assert.equal(normalizeBiosHostSettings({ automation: { enabled: false, localBookkeeping: true, injectProjectData: true, version: 9 } }).automation.enabled, false);

	const settings = normalizeBiosHostSettings({ automation: { enabled: true, localBookkeeping: true, injectProjectData: true, version: 2 } });
	const env = biosProcessEnv(settings);
	assert.equal(env.BIOS_AUTOMATION_ENABLED, "1");
	assert.equal(env.BIOS_AUTOMATION_BOOKKEEPING, "1");
	assert.equal(env.BIOS_AUTOMATION_INJECT, "1");
	assert.equal(env.BIOS_AUTOMATION_VERSION, "2");
	for (const key of ["BIOS_AUTOMATION_ENABLED", "BIOS_AUTOMATION_BOOKKEEPING", "BIOS_AUTOMATION_INJECT", "BIOS_AUTOMATION_VERSION"]) {
		assert.ok(BIOS_CONFIG_ENV_KEYS.includes(key), `${key} 必须登记在 BIOS_CONFIG_ENV_KEYS，否则旧值会从宿主环境继承`);
	}

	// 关闭后重新注入：旧许可必须被清掉（写 0/0），不能"看起来还开着"。
	const closed = normalizeBiosHostSettings({});
	const stale = applyBiosEnv({ BIOS_AUTOMATION_ENABLED: "1", BIOS_AUTOMATION_BOOKKEEPING: "1", BIOS_AUTOMATION_INJECT: "1", BIOS_AUTOMATION_VERSION: "9" }, closed);
	assert.equal(stale.BIOS_AUTOMATION_ENABLED, "0");
	assert.equal(stale.BIOS_AUTOMATION_BOOKKEEPING, "0");
	assert.equal(stale.BIOS_AUTOMATION_INJECT, "0");
	assert.equal(stale.BIOS_AUTOMATION_VERSION, "0");
});
