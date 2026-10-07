/** CW：真实 Pi 加载器 + 临时知识库/Git，绝不触碰用户项目或真实模型。 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { initializeKnowledgeStore, readRecord } from "../core/storage/index.ts";
import { confirmProfileFields } from "../core/projects/confirm.ts";
import { reviewExperience } from "../core/knowledge/experiences.ts";
import { searchKnowledge } from "../core/knowledge/search.ts";
import { clearKnowledgeIndex } from "../core/knowledge/searchIndex.ts";
import { memoryMaintenanceCandidates } from "../core/knowledge/maintenance.ts";
import { bindProjectWorkspace } from "../core/projects/index.ts";
import { createProjectSandbox } from "./helpers/projectFixtures.mjs";
import { loadBiosExtension, toolOf, commandOf, visibleBytes } from "./helpers/biosExtension.mjs";

async function fixture() {
	const sb = await createProjectSandbox("cw-tools-");
	await initializeKnowledgeStore({ root: sb.root });
	const bound = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, workspacePath: sb.workspaceA });
	const loaded = await loadBiosExtension();
	// 绑定实际加载器的声明式回执动作；工具与磁盘服务仍是真实实现。
	loaded.runtime.sendMessage = async () => {};
	const old = { ...process.env };
	Object.assign(process.env, { BIOS_KNOWLEDGE_ROOT: sb.root, BIOS_AUTHORIZED_PROJECTS: bound.projectId, BIOS_ENDPOINT: "allowed", BIOS_AUTHORIZED_ROOTS: sb.workspaceA });
	delete process.env.BIOS_APPROVED_CUSTOMERS;
	delete process.env.BIOS_ALLOWED_FEATURE_IDS;
	let confirmations = 0;
	let accept = true;
	const ctx = {
		cwd: sb.workspaceA,
		hasUI: true,
		sessionManager: { getSessionId: () => "cw-session" },
		ui: {
			confirm: async () => {
				confirmations++;
				return accept;
			},
		},
	};
	let callNumber = 0;
	const call = (name, input, context = ctx, signal, callId = `cw-${++callNumber}`) => toolOf(loaded.extension, name).execute(callId, input, signal, undefined, context);
	const task = (input, context, signal) => call("bios_manage_task", input, context, signal);
	await commandOf(loaded.extension, "bios-workflow")("off", ctx);
	return {
		...sb,
		...bound,
		extension: loaded.extension,
		ctx,
		call,
		task,
		get confirmations() {
			return confirmations;
		},
		accept(value) {
			accept = value;
		},
		async cleanup() {
			loaded.cleanup();
			for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
			Object.assign(process.env, old);
			await sb.cleanup();
		},
	};
}
const body = (result) => JSON.parse(result.content[0].text);

test("WM 需求预填：未知/未批准客户拒绝；人工取消不写；批准后创建/授权读取/CAS更新", async () => {
	const f = await fixture();
	try {
		const input = { originalRequirement: "Synthetic PXE requirement", acceptanceCriteria: ["Board verification pending"], aliases: ["PXE"] };
		assert.equal((await f.call("bios_propose_feature", input)).details.status, "needs-customer-authorization");
		await confirmProfileFields({ root: f.root, projectId: f.projectId, workspaceId: f.workspaceId, expectedProfileRevision: 0, values: [{ field: "customer", value: "Synthetic-Customer" }], operatorLabel: "Synthetic engineer" });
		assert.equal((await f.call("bios_propose_feature", input)).details.status, "needs-customer-authorization");
		process.env.BIOS_APPROVED_CUSTOMERS = "Synthetic-Customer";
		f.accept(false);
		assert.equal((await f.call("bios_propose_feature", input)).details.status, "declined");
		f.accept(true);
		const result = body(await f.call("bios_propose_feature", input));
		assert.equal(result.status, "created");
		const feature = (await readRecord({ root: f.root, kind: "feature-record", id: result.featureId })).record;
		assert.equal(feature.customer.value, "Synthetic-Customer");
		assert.deepEqual(feature.acceptanceCriteria, input.acceptanceCriteria);
		assert.equal(body(await f.call("bios_propose_feature", { ...input, featureId: result.featureId, expectedRevision: 0, originalRequirement: "Changed" })).status, "updated");
		assert.equal(body(await f.call("bios_propose_feature", { ...input, featureId: result.featureId, expectedRevision: 0 })).status, "revision-conflict");
	} finally {
		await f.cleanup();
	}
});

test("WM 自动经验回链、不同调用精确草稿去重、回链冲突不撤销已保存记录", async () => {
	const f = await fixture();
	try {
		const task = body(await f.task({ action: "create", requirement: "Synthetic WM" }));
		const saved = body(await f.call("bios_save_experience_draft", { problem: "Exact repeat", taskId: task.taskId, expectedTaskRevision: 0 }));
		assert.equal(saved.status, "created");
		assert.equal(saved.link.status, "updated");
		assert.deepEqual((await readRecord({ root: f.root, kind: "task-record", id: task.taskId, projectId: f.projectId })).record.sourceExperienceIds, [saved.experienceId]);
		const again = body(await f.call("bios_save_experience_draft", { problem: "Exact repeat" }));
		assert.equal(again.status, "unchanged");
		assert.equal(again.experienceId, saved.experienceId);
		const conflict = body(await f.call("bios_save_experience_draft", { problem: "Different lesson", taskId: task.taskId, expectedTaskRevision: 0 }));
		assert.equal(conflict.status, "created");
		assert.equal(conflict.link.status, "revision-conflict");
		assert.equal((await readRecord({ root: f.root, kind: "experience-card", id: conflict.experienceId })).record.status, "draft");
	} finally {
		await f.cleanup();
	}
});

test("WM 维护不自动选赢家；人工退出保留审计与替代具名版本；恢复仅回draft", async () => {
	const f = await fixture();
	try {
		const a = body(await f.call("bios_save_experience_draft", { problem: "Same symptom", solution: "Solution A" }));
		const b = body(await f.call("bios_save_experience_draft", { problem: "Same symptom", solution: "Solution B" }));
		const input = { root: f.root, authorizedProjectIds: [f.projectId], operatorLabel: "Synthetic reviewer", reason: "Synthetic review" };
		await reviewExperience({ ...input, experienceId: a.experienceId, expectedRevision: 0, action: "submit-review" });
		await reviewExperience({ ...input, experienceId: b.experienceId, expectedRevision: 0, action: "submit-review" });
		const inspected = body(await f.call("bios_maintain_memory", { action: "inspect" }));
		assert.equal(inspected.candidates[0].kind, "possible-conflict");
		const query = { root: f.root, useIndex: true, query: "Same symptom", visibility: { authorizedProjectIds: [f.projectId] }, target: { projectId: f.projectId, customerId: null }, authorization: { endpointAllowed: true, allowInternalGeneral: false } };
		const conflictSearch = await searchKnowledge(query);
		assert.ok(conflictSearch.hits.every((hit) => hit.recommendation === "conflict"));
		assert.ok(conflictSearch.decision.items.every((item) => item.class === "conflict"));
		const retire = { action: "retire", experienceId: a.experienceId, expectedRevision: 1, replacementId: b.experienceId, replacementRevision: 1, reason: "Engineer chooses B in same declared scope" };
		f.accept(false);
		assert.equal((await f.call("bios_maintain_memory", retire)).details.status, "declined");
		f.accept(true);
		assert.equal(body(await f.call("bios_maintain_memory", retire)).stateAfter, "deprecated");
		const retiredSearch = await searchKnowledge(query);
		assert.ok(!retiredSearch.hits.some((hit) => hit.recordId === a.experienceId && hit.recommendation !== "excluded"));
		assert.ok(!retiredSearch.hits.some((hit) => hit.recommendation === "conflict"));
		const history = body(await f.call("bios_maintain_memory", { action: "history", experienceId: a.experienceId }));
		assert.equal(history.events.length, 2);
		assert.equal(history.events[1].evidence[0].recordId, b.experienceId);
		assert.match(history.events[1].evidence[0].note, /revision=1/);
		assert.equal(body(await f.call("bios_maintain_memory", { action: "restore", experienceId: a.experienceId, expectedRevision: 2, reason: "Needs investigation" })).stateAfter, "draft");
	} finally {
		await f.cleanup();
	}
});

test("WM 索引删除/损坏/取消如实处理，跨工作区相似方案不判冲突", async () => {
	const f = await fixture();
	try {
		clearKnowledgeIndex();
		const a = body(await f.call("bios_save_experience_draft", { problem: "Index deletion" }));
		const query = { root: f.root, useIndex: true, query: "Index", visibility: { authorizedProjectIds: [f.projectId] }, target: { projectId: f.projectId, customerId: null }, authorization: { endpointAllowed: true, allowInternalGeneral: false } };
		assert.equal((await searchKnowledge(query)).hits.length, 1);
		const card = (await readRecord({ root: f.root, kind: "experience-card", id: a.experienceId })).record;
		assert.deepEqual(memoryMaintenanceCandidates([card, { ...card, id: "other-workspace", solution: "different", evidence: [{ type: "session", workspaceId: "other", location: "synthetic" }] }], null), []);
		await unlink(join(f.root, "experiences", `${a.experienceId}.json`));
		assert.equal((await searchKnowledge(query)).hits.length, 0);
		await writeFile(join(f.root, "experiences", "broken.json"), "invalid synthetic JSON");
		const broken = await searchKnowledge(query);
		assert.equal(broken.status, "incomplete");
		assert.deepEqual(broken.hits, []);
		const abort = new AbortController();
		abort.abort();
		await assert.rejects(searchKnowledge({ ...query, signal: abort.signal }), /取消|cancel/i);
	} finally {
		clearKnowledgeIndex();
		await f.cleanup();
	}
});

test("WM 确认期间身份变化/撤权不写正式需求；维护非法动作拒绝", async () => {
	const f = await fixture();
	try {
		await confirmProfileFields({ root: f.root, projectId: f.projectId, workspaceId: f.workspaceId, expectedProfileRevision: 0, values: [{ field: "customer", value: "Synthetic-Customer" }], operatorLabel: "Synthetic engineer" });
		process.env.BIOS_APPROVED_CUSTOMERS = "Synthetic-Customer";
		const input = { originalRequirement: "Synthetic requirement", acceptanceCriteria: ["Pending"] };
		const context = {
			...f.ctx,
			ui: {
				confirm: async () => {
					await confirmProfileFields({ root: f.root, projectId: f.projectId, workspaceId: f.workspaceId, expectedProfileRevision: 1, values: [{ field: "boardName", value: "Changed during dialog" }], operatorLabel: "Synthetic engineer" });
					return true;
				},
			},
		};
		assert.equal((await f.call("bios_propose_feature", input, context)).details.status, "stale");
		const revoke = {
			...f.ctx,
			ui: {
				confirm: async () => {
					process.env.BIOS_APPROVED_CUSTOMERS = "";
					return true;
				},
			},
		};
		assert.notEqual((await f.call("bios_propose_feature", input, revoke)).details.status, "created");
		assert.equal((await f.call("bios_maintain_memory", { action: "delete" })).details.status, "invalid-argument");
	} finally {
		await f.cleanup();
	}
});

test("WM 增量索引冷建/热检索/更改/退出/新增/撤权仍按权威JSON复验", async () => {
	const f = await fixture();
	try {
		clearKnowledgeIndex();
		const a = body(await f.call("bios_save_experience_draft", { problem: "Index S3" }));
		const query = { root: f.root, useIndex: true, query: "Index", visibility: { authorizedProjectIds: [f.projectId] }, target: { projectId: f.projectId, customerId: null }, authorization: { endpointAllowed: true, allowInternalGeneral: false } };
		const cold = await searchKnowledge(query);
		const warm = await searchKnowledge(query);
		assert.equal(cold.hits.length, 1);
		assert.equal(warm.hits.length, 1);
		assert.ok(warm.scanned.recordsRead < cold.scanned.recordsRead);
		await f.call("bios_save_experience_draft", { experienceId: a.experienceId, expectedRevision: 0, problem: "Renamed S3" });
		assert.equal((await searchKnowledge(query)).hits.length, 0);
		await f.call("bios_save_experience_draft", { problem: "Index PXE" });
		assert.equal((await searchKnowledge(query)).hits.length, 1);
		const denied = await searchKnowledge({ ...query, visibility: { authorizedProjectIds: [] } });
		assert.deepEqual(denied.hits, []);
		assert.equal(denied.scanned.recordsRead, 0);
		const small = await searchKnowledge({ ...query, limits: { maxScanRecords: 1 } });
		assert.ok(small.scanned.recordsRead <= 1);
		clearKnowledgeIndex();
		assert.equal((await searchKnowledge({ ...query, limits: { maxScanRecords: 1 } })).status, "incomplete");
	} finally {
		clearKnowledgeIndex();
		await f.cleanup();
	}
});

test("CW 注册受限工具；没有授权/源码目录/审核/验证参数", async () => {
	const f = await fixture();
	try {
		assert.equal(f.extension.tools.size, 13);
		for (const name of ["bios_manage_task", "bios_read_history", "bios_save_experience_draft", "bios_confirm_project_fields"]) {
			const keys = Object.keys(toolOf(f.extension, name).parameters.properties);
			for (const forbidden of ["root", "cwd", "authorizedProjectIds", "endpoint", "sourceProjectId", "reviewer", "validations", "reuse"]) assert.ok(!keys.includes(forbidden));
		}
	} finally {
		await f.cleanup();
	}
});

test("CW 一次许可 → 创建/更新/CAS冲突 → 唯一任务续接，不注入整库", async () => {
	const f = await fixture();
	try {
		assert.deepEqual(body(await f.task({ action: "list" })).tasks, []);
		const created = body(await f.task({ action: "create", requirement: "Investigate synthetic S3", todos: ["Inspect logs"] }));
		assert.equal(created.status, "created");
		assert.equal(f.confirmations, 1);
		const id = created.taskId;
		const updated = body(await f.task({ action: "update", taskId: id, expectedRevision: 0, todos: ["Board check pending"] }));
		assert.equal(updated.status, "updated");
		assert.equal(f.confirmations, 1);
		assert.equal(body(await f.task({ action: "update", taskId: id, expectedRevision: 0, todos: ["overwrite"] })).status, "revision-conflict");
		assert.equal((await readRecord({ root: f.root, kind: "task-record", id, projectId: f.projectId })).record.todos[0], "Board check pending");
		const resumed = body(await f.task({ action: "resume" }));
		assert.equal(resumed.taskId, id);
		assert.equal(resumed.status, "selected", "瘦身链需要正文中的真实状态，不能只靠 details");
		assert.equal(f.confirmations, 1);
		await f.task({ action: "create", requirement: "Another task" });
		const ambiguous = await f.task({ action: "resume" });
		assert.equal(ambiguous.details.status, "needs-selection");
		assert.ok(ambiguous.details.budget.usedBytes <= 12000);
	} finally {
		await f.cleanup();
	}
});

test("CW 无确认/拒绝/预先取消/未授权/错工作区均不写入", async () => {
	const f = await fixture();
	try {
		assert.equal((await f.task({ action: "create", requirement: "x" }, { ...f.ctx, hasUI: false })).details.status, "confirmation-unavailable");
		f.accept(false);
		assert.equal((await f.task({ action: "create", requirement: "x" })).details.status, "declined");
		const abort = new AbortController();
		abort.abort();
		await f.task({ action: "create", requirement: "x" }, f.ctx, abort.signal);
		process.env.BIOS_ENDPOINT = "unknown";
		assert.equal((await f.task({ action: "create", requirement: "x" })).details.status, "endpoint-denied");
		process.env.BIOS_ENDPOINT = "allowed";
		process.env.BIOS_AUTHORIZED_PROJECTS = "";
		assert.equal((await f.task({ action: "list" })).details.status, "not-ready");
		process.env.BIOS_AUTHORIZED_PROJECTS = f.projectId;
		assert.equal((await f.task({ action: "create", requirement: "x" }, { ...f.ctx, cwd: f.workspaceB })).details.status, "not-bound");
		assert.deepEqual(body(await f.task({ action: "list" })).tasks, []);
	} finally {
		await f.cleanup();
	}
});

test("CW 确认期间撤权/换会话/off不能重新复活许可；关键结束逐次确认", async () => {
	const f = await fixture();
	try {
		const revoke = {
			...f.ctx,
			ui: {
				confirm: async () => {
					process.env.BIOS_AUTHORIZED_PROJECTS = "";
					return true;
				},
			},
		};
		await f.task({ action: "create", requirement: "must not save" }, revoke);
		process.env.BIOS_AUTHORIZED_PROJECTS = f.projectId;
		const off = {
			...f.ctx,
			ui: {
				confirm: async () => {
					await commandOf(f.extension, "bios-workflow")("off", f.ctx);
					return true;
				},
			},
		};
		assert.equal((await f.task({ action: "create", requirement: "no resurrection" }, off)).details.status, "stale");
		const created = body(await f.task({ action: "create", requirement: "real task" }));
		await f.task({ action: "status", taskId: created.taskId, expectedRevision: 0, to: "in_progress", reason: "investigating" });
		const before = f.confirmations;
		f.accept(false);
		assert.equal((await f.task({ action: "status", taskId: created.taskId, expectedRevision: 1, to: "done", reason: "finish" })).details.status, "declined");
		assert.equal(f.confirmations, before + 1);
		f.accept(true);
		await commandOf(f.extension, "bios-workflow")("off", f.ctx);
		await f.task({ action: "update", taskId: created.taskId, expectedRevision: 1, todos: [] });
		assert.equal(f.confirmations, before + 2);
		assert.equal((await readRecord({ root: f.root, kind: "task-record", projectId: f.projectId, id: created.taskId })).record.status, "in_progress");
		await f.task({ action: "update", taskId: created.taskId, expectedRevision: 1, todos: ["new session"] }, { ...f.ctx, sessionManager: { getSessionId: () => "other-session" } });
		assert.equal(f.confirmations, before + 3, "新会话不能继承许可");
	} finally {
		await f.cleanup();
	}
});

test("CW 同一真实工具调用重试不创建第二份任务或经验，冲突保留原记录", async () => {
	const f = await fixture();
	try {
		for (const [name, input, idKey] of [
			["bios_manage_task", { action: "create", requirement: "one task" }, "taskId"],
			["bios_save_experience_draft", { problem: "one proposal" }, "experienceId"],
		]) {
			const first = body(await f.call(name, input, f.ctx, undefined, "retry-same-call"));
			const again = body(await f.call(name, input, f.ctx, undefined, "retry-same-call"));
			assert.equal(first.status, "created");
			assert.equal(again.status, "revision-conflict");
			assert.equal(again[idKey], first[idKey]);
		}
		assert.equal(body(await f.task({ action: "list" })).tasks.length, 1);
	} finally {
		await f.cleanup();
	}
});

test("CW 经验来源派生、未知保留、只存draft无验证；模型伪造状态拒绝", async () => {
	const f = await fixture();
	try {
		assert.equal((await f.call("bios_save_experience_draft", { problem: "fake", status: "verified" })).details.status, "invalid-argument");
		const saved = body(await f.call("bios_save_experience_draft", { problem: "Synthetic resume issue" }));
		assert.equal(saved.status, "created");
		const card = (await readRecord({ root: f.root, kind: "experience-card", id: saved.experienceId })).record;
		assert.equal(card.status, "draft");
		assert.equal(card.sourceProjectId, f.projectId);
		assert.deepEqual(card.validations, []);
		assert.equal(card.reuseScope.level, "current-project");
		assert.match(card.rootCause, /未确认/);
		assert.equal(card.evidence[0].workspaceId, f.workspaceId);
		const update = body(await f.call("bios_save_experience_draft", { experienceId: saved.experienceId, expectedRevision: 0, problem: "More precise symptom", solution: "Proposed, not verified" }));
		assert.equal(update.status, "updated");
		assert.equal(f.confirmations, 1);
	} finally {
		await f.cleanup();
	}
});

test("CW Git 只读有界、固定SHA/分批游标、diff与草稿来源；非法ref/子目录拒绝", async () => {
	const f = await fixture();
	const git = (args) => execFileSync("git", args, { cwd: f.workspaceA, encoding: "utf8", windowsHide: true }).trim();
	try {
		git(["init"]);
		git(["-c", "user.name=Synthetic", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Initial synthetic"]);
		git(["-c", "user.name=Synthetic", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Fix synthetic bug"]);
		const before = git(["status", "--porcelain"]);
		const scan = body(await f.call("bios_read_history", { limit: 1 }));
		assert.equal(scan.commits.length, 1);
		assert.equal(scan.hasMore, true);
		assert.match(scan.nextStartCommit, /^[0-9a-f]{40,64}$/);
		const detail = body(await f.call("bios_read_history", { commit: scan.commits[0].sha }));
		assert.equal(detail.comparison, "first-parent");
		assert.equal(detail.commit, scan.head);
		const saved = body(await f.call("bios_save_experience_draft", { problem: "History proposal", commit: detail.commit }));
		const card = (await readRecord({ root: f.root, kind: "experience-card", id: saved.experienceId })).record;
		assert.ok(card.evidence.some((e) => e.type === "commit" && e.commit === scan.head));
		assert.equal((await f.call("bios_read_history", { commit: "--help" })).details.status, "invalid-argument");
		process.env.BIOS_ENDPOINT = "denied";
		assert.ok(!visibleBytes(await f.call("bios_read_history", {})).includes("Fix synthetic bug"));
		assert.equal(git(["status", "--porcelain"]), before);
	} finally {
		await f.cleanup();
	}
});

test("CW 项目字段必须真正人工确认且CAS，不把回答当自动授权", async () => {
	const f = await fixture();
	try {
		f.accept(false);
		const input = { expectedProfileRevision: 0, values: [{ field: "ibv", value: "AMI" }] };
		assert.equal((await f.call("bios_confirm_project_fields", input)).details.status, "declined");
		f.accept(true);
		assert.equal(body(await f.call("bios_confirm_project_fields", input)).status, "confirmed");
		const profile = (await readRecord({ root: f.root, kind: "project-profile", id: f.projectId })).record;
		assert.equal(profile.identity.ibv.value, "AMI");
		assert.equal(profile.identity.customer.status, "unknown");
		assert.equal(body(await f.call("bios_confirm_project_fields", { ...input, values: [{ field: "ibv", value: "Insyde" }] })).status, "revision-conflict");
	} finally {
		await f.cleanup();
	}
});

test("CW 原生确认传递取消信号；确认期间取消不落库", async () => {
	const f = await fixture();
	try {
		const abort = new AbortController();
		const ctx = {
			...f.ctx,
			ui: {
				confirm: async (_title, _message, options) => {
					assert.equal(options.signal, abort.signal);
					assert.equal(options.timeout, 120000);
					abort.abort();
					return true;
				},
			},
		};
		assert.equal((await f.task({ action: "create", requirement: "cancel during confirmation" }, ctx, abort.signal)).details.status, "cancelled");
		assert.deepEqual(body(await f.task({ action: "list" })).tasks, []);
	} finally {
		await f.cleanup();
	}
});

test("CW 已登记子目录也不能隐式读取父 Git 仓库", async () => {
	const f = await fixture();
	try {
		execFileSync("git", ["init"], { cwd: f.workspaceA, windowsHide: true });
		const child = join(f.workspaceA, "registered-child");
		await mkdir(child);
		const bound = await bindProjectWorkspace({ root: f.root, cwd: child, workspacePath: child, authorizedRoots: [f.workspaceA] });
		process.env.BIOS_AUTHORIZED_PROJECTS = bound.projectId;
		assert.equal((await f.call("bios_read_history", {}, { ...f.ctx, cwd: child })).details.status, "not-repository-root");
	} finally {
		await f.cleanup();
	}
});
