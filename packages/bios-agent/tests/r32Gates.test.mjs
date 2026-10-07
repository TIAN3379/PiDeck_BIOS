/**
 * R32 永久回归：**动态外发/身份/证据门禁**、**保留来源**与**极小预算**。
 *
 * 覆盖第三十二轮验收的 R32-1/R32-2/R32-3：
 * - R32-1：判定后、输出前策略/授权/知识根/选择变化或取消 ⇒ **丢弃旧正文**（不是换个状态标签继续发）；
 * - R32-2：交接复用工作区身份门禁与证据复验；身份不可用不给路径/当前续跑正文；
 *   预算裁剪后来源清单跟着收缩（retained ≠ inspected）；需求来源也末尾重验；
 * - R32-3：任意合法正整数预算下正文与截断提示都不越限；`context.ts` 已按内聚职责拆分且入口兼容。
 *
 * 方法与验收一致：**先启动 Promise（不 await），在读取完成前改变可信配置**，再 await 看结果。
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { initializeKnowledgeStore, readRecord, updateRecord } from "../core/storage/index.ts";
import { bindProjectWorkspace, confirmProfileFields, readProjectView } from "../core/projects/index.ts";
import { createExperienceDraft, createFeature, reviewExperience } from "../core/knowledge/index.ts";
import { createTask, updateTask } from "../core/tasks/index.ts";
import { buildHandoff } from "../core/context/index.ts";
import { boundText } from "../extensions/outbound.ts";
import { callTool, commandOf, loadBiosExtension, PACKAGE_ROOT, toolOf, visibleBytes } from "./helpers/biosExtension.mjs";
import { createProjectSandbox, fileHash, writeDsc } from "./helpers/projectFixtures.mjs";

const NOW = 1_700_000_000_000;
const SECRET_TASK = "SECRET-R32-TASK-REQUIREMENT";
const SECRET_ROOT_CAUSE = "SECRET-R32-ROOT-CAUSE";
const SECRET_FEATURE = "SECRET-R32-FEATURE-REQUIREMENT";

async function sandbox() {
	const sb = await createProjectSandbox("bm07-r32-");
	await initializeKnowledgeStore({ root: sb.root, now: NOW });
	await writeDsc(sb.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformA" });
	await mkdir(sb.workspaceB, { recursive: true });
	await writeDsc(sb.workspaceB, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformB" });
	const projectA = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA, sb.workspaceB], workspacePath: sb.workspaceA, now: NOW });
	const projectB = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceB, authorizedRoots: [sb.workspaceA, sb.workspaceB], workspacePath: sb.workspaceB, now: NOW });
	await createFeature({
		root: sb.root,
		feature: { featureId: "feat-r32", originalRequirement: SECRET_FEATURE, aliases: ["r32f"], customer: { value: "customer-alpha", status: "confirmed" }, productLine: { value: "line-x", status: "confirmed" }, acceptanceCriteria: ["验收一"], relatedExperienceIds: ["exp-r32"] },
		now: NOW + 1,
	});
	const created = await createExperienceDraft({ root: sb.root, authorizedProjectIds: [projectA.projectId], experience: { experienceId: "exp-r32", problem: "PXE 默认开启", rootCause: SECRET_ROOT_CAUSE, solution: "关闭默认值", sourceProjectId: projectA.projectId, reuse: { level: "current-project" } }, now: NOW + 2 });
	await reviewExperience({ root: sb.root, authorizedProjectIds: [projectA.projectId], experienceId: "exp-r32", expectedRevision: created.revision, action: "submit-review", operatorLabel: "e", reason: "ok", now: NOW + 3 });
	await createTask({ root: sb.root, projectId: projectA.projectId, taskId: "task-r32", workspaceId: projectA.workspaceId, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], requirement: SECRET_TASK, todos: ["待办一"], authorizedProjectIds: [projectA.projectId] });
	await updateTask({ root: sb.root, projectId: projectA.projectId, taskId: "task-r32", expectedRevision: 0, changes: { sourceExperienceIds: ["exp-r32"] }, authorizedProjectIds: [projectA.projectId], now: NOW + 4 });
	return { ...sb, projectA, projectB };
}

const ENV_KEYS = ["BIOS_KNOWLEDGE_ROOT", "BIOS_AUTHORIZED_PROJECTS", "BIOS_ALLOWED_FEATURE_IDS", "BIOS_APPROVED_CUSTOMERS", "BIOS_ENDPOINT", "BIOS_AUTHORIZED_ROOTS", "BIOS_ALLOW_INTERNAL_GENERAL", "BIOS_ENDPOINT_GRANT"];

/** 设置可信配置（返回恢复函数）。 */
function setEnv(values) {
	const saved = {};
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key];
		if (values[key] === undefined) delete process.env[key];
		else process.env[key] = values[key];
	}
	return () => {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	};
}

function allowedEnv(sb) {
	return { BIOS_KNOWLEDGE_ROOT: sb.root, BIOS_AUTHORIZED_PROJECTS: sb.projectA.projectId, BIOS_ALLOWED_FEATURE_IDS: "feat-r32", BIOS_APPROVED_CUSTOMERS: "customer-alpha", BIOS_ENDPOINT: "allowed", BIOS_AUTHORIZED_ROOTS: sb.workspaceA };
}

async function withExtension(sb, fn) {
	const { extension, cleanup } = await loadBiosExtension();
	try {
		return await fn(extension);
	} finally {
		cleanup();
	}
}

/** 选中任务 + 打开上下文（同一会话身份）。 */
async function selectAndEnable(extension, sb) {
	const sessionManager = { getSessionId: () => "s-r32" };
	const ctx = { cwd: sb.workspaceA, sessionManager };
	await commandOf(extension, "bios-task")(`select ${sb.projectA.projectId} task-r32 ${sb.projectA.workspaceId}`, ctx);
	await commandOf(extension, "bios-context")("on", ctx);
	return ctx;
}

/* ------------------------------------------------------------------ R32-1 */

test("F2: output rechecks the live model getter after asynchronous reads", async () => {
	const sb = await sandbox();
	const restore = setEnv({ ...allowedEnv(sb), BIOS_ENDPOINT_GRANT: JSON.stringify({ provider: "synthetic", modelId: "approved", origin: "https://synthetic.invalid", version: 1 }) });
	try {
		await withExtension(sb, async (extension) => {
			let model = { provider: "synthetic", id: "approved", baseUrl: "https://synthetic.invalid/v1" };
			const ctx = {
				cwd: sb.workspaceA,
				sessionManager: { getSessionId: () => "f2-async" },
				get model() {
					return model;
				},
			};
			const input = { projectId: sb.projectA.projectId, taskId: "task-r32" };
			const invoke = () => toolOf(extension, "bios_get_task").execute("f2-async-call", input, undefined, undefined, ctx);
			assert.ok(visibleBytes(await invoke()).includes(SECRET_TASK));
			for (const next of [{ ...model, id: "unapproved" }, { ...model, baseUrl: "https://other.invalid/v1" }, undefined]) {
				model = { provider: "synthetic", id: "approved", baseUrl: "https://synthetic.invalid/v1" };
				const pending = invoke();
				model = next;
				const result = await pending;
				assert.ok(!visibleBytes(result).includes(SECRET_TASK));
				assert.equal(result.details.withheld, true);
			}
		});
	} finally {
		restore();
		await sb.cleanup();
	}
});

test("R32-1：工具在读取途中被撤权/改端点/换知识根 —— 输出前复查，丢弃旧正文", async () => {
	const sb = await sandbox();
	try {
		await withExtension(sb, async (extension) => {
			const restore = setEnv(allowedEnv(sb));
			try {
				const ctx = await selectAndEnable(extension, sb);
				// 正对照：允许时确实读到任务正文（否则"撤回"是假象）。
				const positive = await callTool(extension, "bios_get_task", { projectId: sb.projectA.projectId, taskId: "task-r32" }, ctx);
				assert.equal(positive.details.status, "ok");
				assert.ok(visibleBytes(positive).includes(SECRET_TASK), "允许端点下应读到任务正文");

				const cases = [
					{ label: "allowed→denied", apply: () => (process.env.BIOS_ENDPOINT = "denied") },
					{ label: "allowed→unknown", apply: () => (process.env.BIOS_ENDPOINT = "unknown") },
					{ label: "项目撤权", apply: () => delete process.env.BIOS_AUTHORIZED_PROJECTS },
					{
						label: "客户/需求撤权",
						apply: () => {
							delete process.env.BIOS_ALLOWED_FEATURE_IDS;
							delete process.env.BIOS_APPROVED_CUSTOMERS;
						},
					},
					{ label: "知识根变化", apply: () => (process.env.BIOS_KNOWLEDGE_ROOT = sb.workspaceB) },
					{ label: "目录根变化", apply: () => (process.env.BIOS_AUTHORIZED_ROOTS = sb.workspaceB) },
				];
				for (const scenario of cases) {
					const restoreCase = setEnv(allowedEnv(sb));
					try {
						// 先启动读取（不 await），在读取完成前改可信配置，再 await。
						const pending = callTool(extension, "bios_get_task", { projectId: sb.projectA.projectId, taskId: "task-r32" }, ctx);
						scenario.apply();
						const result = await pending;
						const visible = visibleBytes(result);
						assert.ok(!visible.includes(SECRET_TASK), `${scenario.label}：不得输出旧任务正文（${visible.slice(0, 400)}）`);
						assert.notEqual(result.details.status, "ok", `${scenario.label}：不得报 ok`);
						assert.equal(result.details.withheld, true, `${scenario.label}：必须显式标记 withheld`);
						// 信封必须反映**当前**策略（不是判定时的旧策略）。
						if (scenario.label === "allowed→denied") assert.equal(result.details.outbound.allowCommercialBody, false, "信封里的外发策略必须是当前值");
					} finally {
						restoreCase();
					}
				}
			} finally {
				restore();
			}
		});
	} finally {
		await sb.cleanup();
	}
});

test("R32-1：读取途中被取消 ⇒ cancelled，且不返回已读正文", async () => {
	const sb = await sandbox();
	try {
		await withExtension(sb, async (extension) => {
			const restore = setEnv(allowedEnv(sb));
			try {
				const ctx = await selectAndEnable(extension, sb);
				const controller = new AbortController();
				const pending = callTool(extension, "bios_get_task", { projectId: sb.projectA.projectId, taskId: "task-r32" }, { ...ctx, signal: controller.signal });
				controller.abort();
				const result = await pending;
				assert.equal(result.details.status, "cancelled", `应为 cancelled（实际 ${result.details.status}）`);
				assert.ok(!visibleBytes(result).includes(SECRET_TASK), "取消后不得返回已读正文");
			} finally {
				restore();
			}
		});
	} finally {
		await sb.cleanup();
	}
});

test("R32-1：上下文注入在组装途中策略变化 ⇒ 不注入旧商业正文", async () => {
	const sb = await sandbox();
	try {
		await withExtension(sb, async (extension) => {
			const restore = setEnv(allowedEnv(sb));
			try {
				const ctx = await selectAndEnable(extension, sb);
				const handlers = extension.handlers.get("context") ?? [];
				assert.ok(handlers.length > 0, "必须注册 context 处理器");
				// 正对照：允许时注入正文。
				const positive = await handlers[0]({ type: "context", messages: [] }, ctx);
				assert.ok(JSON.stringify(positive?.messages ?? []).includes(SECRET_TASK), "允许时应注入任务正文");

				for (const [label, apply] of [
					["allowed→denied", () => (process.env.BIOS_ENDPOINT = "denied")],
					["项目撤权", () => delete process.env.BIOS_AUTHORIZED_PROJECTS],
					["知识根变化", () => (process.env.BIOS_KNOWLEDGE_ROOT = sb.workspaceB)],
				]) {
					const restoreCase = setEnv(allowedEnv(sb));
					try {
						const pending = handlers[0]({ type: "context", messages: [] }, ctx);
						apply();
						const result = await pending;
						const dump = JSON.stringify(result?.messages ?? []);
						assert.ok(!dump.includes(SECRET_TASK), `${label}：注入不得含旧任务正文（${dump.slice(0, 300)}）`);
						assert.ok(!dump.includes(SECRET_ROOT_CAUSE), `${label}：注入不得含旧经验正文`);
					} finally {
						restoreCase();
					}
				}
			} finally {
				restore();
			}
		});
	} finally {
		await sb.cleanup();
	}
});

/* ------------------------------------------------------------------ R32-2 */

test("R32-2：会话目录不在任务工作区授权范围 ⇒ 预览与注入都不给路径/当前续跑正文", async () => {
	const sb = await sandbox();
	try {
		await withExtension(sb, async (extension) => {
			// 任务绑定 ws-a，本次 ctx.cwd = ws-b，且不注入额外授权根。
			const restore = setEnv({ ...allowedEnv(sb), BIOS_AUTHORIZED_ROOTS: sb.workspaceB });
			try {
				const sessionManager = { getSessionId: () => "s-r32-id" };
				const ctx = { cwd: sb.workspaceB, sessionManager };
				await commandOf(extension, "bios-task")(`select ${sb.projectA.projectId} task-r32 ${sb.projectA.workspaceId}`, { ...ctx, cwd: sb.workspaceA });
				await commandOf(extension, "bios-context")("on", { ...ctx, cwd: sb.workspaceA });

				const task = await callTool(extension, "bios_get_task", { projectId: sb.projectA.projectId, taskId: "task-r32" }, ctx);
				assert.notEqual(task.details.status, "ok");
				assert.ok(!visibleBytes(task).includes(SECRET_TASK), "任务工具不得输出正文");

				const preview = await callTool(extension, "bios_preview_context", {}, ctx);
				const visible = visibleBytes(preview);
				assert.notEqual(preview.details.status, "ok", "身份不可用时不得报 ok");
				assert.ok(!visible.includes(SECRET_TASK), `预览不得含任务正文（${visible.slice(0, 400)}）`);
				assert.ok(!visible.includes(sb.workspaceA), "预览不得回显未授权工作区的绝对路径");
				assert.ok(/身份闸门|授权范围/.test(visible), "必须说明身份缺口");

				const handlers = extension.handlers.get("context") ?? [];
				const injected = await handlers[0]({ type: "context", messages: [] }, ctx);
				const dump = JSON.stringify(injected?.messages ?? []);
				assert.ok(!dump.includes(SECRET_TASK), "注入不得含任务正文");
				assert.ok(!dump.includes(sb.workspaceA.replace(/\\/g, "\\\\")) && !dump.includes(sb.workspaceA), "注入不得含未授权工作区路径");
			} finally {
				restore();
			}
		});
	} finally {
		await sb.cleanup();
	}
});

test("R32-2：人工确认值发生证据漂移 ⇒ 预览标需复核，且不再作为 M1 目标依据", async () => {
	const sb = await sandbox();
	try {
		const dscPath = join(sb.workspaceA, "Platform/SamplePkg/Sample.dsc");
		const hash = await fileHash(dscPath);
		const opened = await readRecord({ root: sb.root, kind: "project-profile", id: sb.projectA.projectId });
		await confirmProfileFields({
			root: sb.root,
			projectId: sb.projectA.projectId,
			workspaceId: sb.projectA.workspaceId,
			expectedProfileRevision: opened.record.revision,
			values: [{ field: "boardName", value: "SyntheticBoard-X", evidence: [{ relativePath: "Platform/SamplePkg/Sample.dsc", contentHash: hash }] }],
			operatorLabel: "engineer-r32",
			now: NOW + 10,
		});
		// 有证据时：确认值可用，且 M1 目标能拿到板卡名。
		const beforeView = await readProjectView({ root: sb.root, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], biosProjectId: sb.projectA.projectId, verifyEvidence: true, probeVcs: false, now: NOW + 11 });
		assert.equal(
			beforeView.decision?.items.some((item) => item.factKey === "project-profile.boardName" && item.class === "needs-review"),
			false,
			"证据未变时不应判需复核",
		);
		const before = await buildHandoff({
			root: sb.root,
			targetProjectId: sb.projectA.projectId,
			taskId: "task-r32",
			workspaceId: sb.projectA.workspaceId,
			cwd: sb.workspaceA,
			authorizedRoots: [sb.workspaceA],
			authorizedProjectIds: [sb.projectA.projectId],
			endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] },
			now: NOW + 12,
		});
		assert.ok(before.text.includes("SyntheticBoard-X"), "证据未变时应显示人工确认值");
		assert.ok(!before.text.includes("需复核"), "证据未变时不应出现需复核提示");

		// 改动被测文件 ⇒ 证据漂移。
		await writeFile(dscPath, `${await readFile(dscPath, "utf8")}\r\n# drift\r\n`, "utf8");
		const afterView = await readProjectView({ root: sb.root, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], biosProjectId: sb.projectA.projectId, verifyEvidence: true, probeVcs: false, now: NOW + 13 });
		const boardItem = afterView.decision?.items.find((item) => item.factKey === "project-profile.boardName");
		assert.equal(boardItem?.class, "needs-review", "证据漂移后必须判需复核");

		const after = await buildHandoff({
			root: sb.root,
			targetProjectId: sb.projectA.projectId,
			taskId: "task-r32",
			workspaceId: sb.projectA.workspaceId,
			cwd: sb.workspaceA,
			authorizedRoots: [sb.workspaceA],
			authorizedProjectIds: [sb.projectA.projectId],
			endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] },
			now: NOW + 14,
		});
		assert.ok(after.text.includes("需复核"), `漂移后预览必须给需复核提示：${after.text.slice(0, 400)}`);
		assert.ok(/不作为当前依据/.test(after.text), "漂移字段必须说明不作为当前依据");
	} finally {
		await sb.cleanup();
	}
});

test("R32-2：预算裁剪后来源清单跟着收缩（retained ≠ inspected），需求正文不再出现", async () => {
	const sb = await sandbox();
	try {
		// 让需求正文足够长：预算 1200 时"当前需求"章节会被裁掉。
		await createFeature({
			root: sb.root,
			feature: { featureId: "feat-long", originalRequirement: "L".repeat(2_000), aliases: ["r32long"], customer: { value: "customer-alpha", status: "confirmed" }, productLine: { value: "line-x", status: "confirmed" }, acceptanceCriteria: [], relatedExperienceIds: [] },
			now: NOW + 20,
		});
		const result = await buildHandoff({
			root: sb.root,
			targetProjectId: sb.projectA.projectId,
			taskId: "task-r32",
			workspaceId: sb.projectA.workspaceId,
			cwd: sb.workspaceA,
			authorizedRoots: [sb.workspaceA],
			authorizedProjectIds: [sb.projectA.projectId],
			allowedFeatureIds: ["feat-r32", "feat-long"],
			endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: ["customer-alpha"] },
			budget: { maxChars: 1_200, maxBytes: 24 * 1024 },
			now: NOW + 21,
		});
		const retainedIds = new Set(result.sources.map((source) => source.recordId));
		const inspectedIds = new Set(result.inspectedSources.map((source) => source.recordId));
		assert.ok(inspectedIds.has("feat-long"), "需求应被**检查**过");
		const retainedFeatureIds = [...retainedIds].filter((id) => id.startsWith("feat-"));
		assert.equal(retainedFeatureIds.length, 0, `保留来源不应包含被裁掉的章节来源（实际 ${JSON.stringify([...retainedIds])}）`);
		assert.ok(result.sources.length <= result.inspectedSources.length);
		assert.ok(!result.text.includes("L".repeat(200)), "被裁掉的章节正文不得出现在正文里");
	} finally {
		await sb.cleanup();
	}
});

test("R32-2：组装期间需求来源变化 ⇒ stale，不输出旧正文", async () => {
	const sb = await sandbox();
	try {
		const pending = buildHandoff({
			root: sb.root,
			targetProjectId: sb.projectA.projectId,
			taskId: "task-r32",
			workspaceId: sb.projectA.workspaceId,
			cwd: sb.workspaceA,
			authorizedRoots: [sb.workspaceA],
			authorizedProjectIds: [sb.projectA.projectId],
			allowedFeatureIds: ["feat-r32"],
			endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: ["customer-alpha"] },
			now: NOW + 30,
		});
		// 读取途中改动需求记录（revision 前进）⇒ 末尾重验必须判 stale。
		const currentFeature = await readRecord({ root: sb.root, kind: "feature-record", id: "feat-r32" });
		const featureData = { ...currentFeature.record };
		delete featureData.id;
		delete featureData.revision;
		delete featureData.schemaVersion;
		delete featureData.createdAt;
		delete featureData.updatedAt;
		await updateRecord({ kind: "feature-record", id: "feat-r32", expectedRevision: currentFeature.record.revision, root: sb.root, now: NOW + 31, data: { ...featureData, originalRequirement: "R32-CHANGED" } });
		const result = await pending;
		if (result.status === "stale") {
			assert.equal(result.text, "", "stale 不得输出旧正文");
			assert.equal(result.sources.length, 0, "stale 不得声称保留了来源");
			assert.ok(result.inspectedSources.length > 0, "stale 仍应如实报告检查过什么");
		} else {
			// 竞争窗口没有命中（改动发生在重读之后）：只允许"不含旧正文"，不允许输出旧内容。
			assert.ok(!result.text.includes(SECRET_FEATURE), "无论如何不得输出已被替换的需求正文");
		}
	} finally {
		await sb.cleanup();
	}
});

/* ------------------------------------------------------------------ R32-3 */

test("R32-3：任意合法正整数预算下正文与截断提示都不越限", async () => {
	const long = "长文本".repeat(200);
	for (const maxChars of [1, 2, 3, 5, 10, 20, 29, 30]) {
		for (const maxBytes of [1, 2, 4, 10, 20, 64]) {
			const bounded = boundText(long, { maxChars, maxBytes, clamped: false });
			assert.ok([...bounded.text].length <= maxChars, `chars 预算 ${maxChars} 被突破：${[...bounded.text].length}`);
			assert.ok(Buffer.byteLength(bounded.text, "utf8") <= maxBytes, `bytes 预算 ${maxBytes} 被突破：${Buffer.byteLength(bounded.text, "utf8")}`);
			assert.equal(bounded.usedChars, [...bounded.text].length);
			assert.equal(bounded.usedBytes, Buffer.byteLength(bounded.text, "utf8"));
		}
	}
	// 只触字符上限：209 个中文字符，chars=10 ⇒ 10 字符以内。
	const charBound = boundText(long, { maxChars: 10, maxBytes: 1024, clamped: false });
	assert.ok([...charBound.text].length <= 10, `只触字符上限时越限：${[...charBound.text].length}`);
	// 只触字节上限：chars 很大，bytes=10 ⇒ 中文字符 3 字节，最多 3 个字符。
	const byteBound = boundText(long, { maxChars: 10_000, maxBytes: 10, clamped: false });
	assert.ok(Buffer.byteLength(byteBound.text, "utf8") <= 10, `只触字节上限时越限：${Buffer.byteLength(byteBound.text, "utf8")}`);
	// 未超限时原样返回（不引入任何包装）。
	const untouched = boundText("短", { maxChars: 10, maxBytes: 10, clamped: false });
	assert.equal(untouched.text, "短");
	assert.equal(untouched.truncated, false);
});

test("R32-3：工具最终 content 也守极小预算（不只 helper）", async () => {
	const sb = await sandbox();
	try {
		await withExtension(sb, async (extension) => {
			const restore = setEnv(allowedEnv(sb));
			try {
				const ctx = await selectAndEnable(extension, sb);
				for (const budgetChars of [1, 10, 20]) {
					const result = await callTool(extension, "bios_get_task", { projectId: sb.projectA.projectId, taskId: "task-r32", budgetChars: undefined }, ctx);
					assert.ok(result !== undefined, "前置调用应成功");
					const preview = await callTool(extension, "bios_preview_context", { budgetChars }, ctx);
					const text = (preview.content ?? []).map((part) => part?.text ?? "").join("");
					assert.ok([...text].length <= budgetChars, `预算 ${budgetChars} 下 content 越限：${[...text].length} 字符（${text.slice(0, 120)}）`);
				}
			} finally {
				restore();
			}
		});
	} finally {
		await sb.cleanup();
	}
});

test("R32-3：context.ts 已按内聚职责拆分（入口兼容、单体文件不再超长）", async () => {
	const contextDir = join(PACKAGE_ROOT, "core", "context");
	const barrel = await readFile(join(contextDir, "context.ts"), "utf8");
	for (const moduleName of ["policy", "sections", "handoff", "manifest"]) {
		assert.match(barrel, new RegExp(`export \\* from "\\./${moduleName}\\.ts"`), `兼容入口必须重导出 ${moduleName}.ts`);
		const content = await readFile(join(contextDir, `${moduleName}.ts`), "utf8");
		assert.ok(content.split("\n").length > 10, `${moduleName}.ts 不应为空壳`);
	}
	assert.ok(barrel.split("\n").length < 60, "入口文件应当是薄兼容层");
	// 行为入口仍然可用（拆分不改导出面）。
	const mod = await import("../core/context/index.ts");
	for (const name of ["buildHandoff", "saveContextManifest", "verifyContextManifest", "outboundPolicy", "guardSourceIdentity", "fitSections"]) {
		assert.equal(typeof mod[name], "function", `${name} 必须仍然导出`);
	}
});

test("R32-1/2：工具 schema 仍未扩权（模型不能改根/授权/端点/审核）", async () => {
	const sb = await sandbox();
	try {
		await withExtension(sb, async (extension) => {
			for (const name of ["bios_get_project_info", "bios_get_task", "bios_search_knowledge", "bios_get_feature", "bios_get_experience", "bios_preview_context"]) {
				const definition = toolOf(extension, name);
				const properties = Object.keys(definition.parameters?.properties ?? {});
				for (const forbidden of ["root", "cwd", "authorizedProjects", "allowedFeatureIds", "customers", "endpoint", "approve", "write", "review", "knowledgeRoot", "authorizedRoots"]) {
					assert.ok(!properties.includes(forbidden), `${name} 不得暴露 ${forbidden}`);
				}
			}
		});
	} finally {
		await sb.cleanup();
	}
});
