#!/usr/bin/env node
/**
 * bios-agent 最小自检：契约、ID 规则、知识根解析与**存储离线演示**。
 *
 * 不启动 Pi、不连模型；只在系统临时目录里创建一次性知识库并清理，
 * 因此可以安全地在 CI 与本地随时运行。
 * 运行：node cli/selfcheck.mjs
 *
 * 本文件参与 `npm run typecheck`（tsconfig 的 checkJs），
 * 这样"自检脚本导入了不存在的导出"这类漂移会被类型检查挡住。
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIOS_AGENT_PACKAGE_NAME, BIOS_AGENT_PACKAGE_VERSION, BIOS_CONTRACTS_SCHEMA_VERSION, RECORD_SCHEMAS, describeIssues, validateRecordByKind } from "../core/contracts/index.ts";
import { KnowledgeIdError } from "../core/contracts/ids.ts";
import { KnowledgePathError, resolveKnowledgePaths, resolveKnowledgeRoot } from "../core/paths.ts";
import { StorageError, initializeKnowledgeStore, readRecord, recordRelativeSegments } from "../core/storage/index.ts";

/** @type {Array<{ label: string; ok: boolean; detail: string }>} */
const checks = [];

/**
 * @param {string} label
 * @param {() => string | Promise<string>} run
 */
async function check(label, run) {
	try {
		checks.push({ label, ok: true, detail: await run() });
	} catch (error) {
		checks.push({ label, ok: false, detail: error instanceof Error ? error.message : String(error) });
	}
}

// `Object.keys` 的返回类型是 string[]（TS 的固有局限）。这里收窄为已登记类型的联合，
// 让下面遍历的集合与 RECORD_SCHEMAS 的键严格一致，而不是绕过类型检查。
const RECORD_KINDS = /** @type {Array<keyof typeof RECORD_SCHEMAS>} */ (Object.keys(RECORD_SCHEMAS));

await check("每个记录类型都拒绝空对象", () => {
	const wrong = RECORD_KINDS.filter((kind) => validateRecordByKind(kind, {}).ok);
	if (wrong.length > 0) throw new Error(`以下类型把空对象当成合法记录：${wrong.join(", ")}`);
	return `已校验 ${RECORD_KINDS.length} 种记录类型`;
});

await check("未知 schemaVersion 被拒绝写入", () => {
	const outcome = validateRecordByKind("experience-card", { schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION + 1 });
	if (outcome.ok) throw new Error("更高的 schemaVersion 被错误接受");
	return `code=${outcome.issues[0]?.code ?? "unknown"}`;
});

await check("缺字段记录给出可读的问题清单", () => {
	const outcome = validateRecordByKind("task-record", { schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION, id: "task-1" });
	if (outcome.ok) throw new Error("缺少必填字段的记录被错误接受");
	const text = describeIssues(outcome.issues, 3);
	if (!text.includes("[invalid-record]")) throw new Error(`问题清单缺少错误码：${text}`);
	return `issues=${outcome.issues.length}`;
});

await check("非法 ID 被拒绝（保留名 / 尾随点 / 大写 / 分隔符）", () => {
	const paths = resolveKnowledgePaths({ root: process.cwd(), source: "override" });
	const rejected = [];
	for (const id of ["con", "con.json", "nul", "com1", "exp.", "Exp", "../escape", "a/b", ""]) {
		try {
			paths.experiencePath(id);
			rejected.push(`未被拒绝：${id}`);
		} catch (error) {
			if (!(error instanceof KnowledgeIdError)) throw error;
		}
	}
	if (rejected.length > 0) throw new Error(rejected.join("；"));
	return "保留名（含点后缀）/ 尾随点 / 大写 / 分隔符均被拒绝";
});

await check("相对知识根被拒绝", () => {
	try {
		resolveKnowledgeRoot({ override: "relative/knowledge", env: {} });
	} catch (error) {
		if (error instanceof KnowledgePathError) return `code=${error.code}`;
		throw error;
	}
	throw new Error("相对知识根未被拒绝");
});

await check("存储离线演示：初始化 → 读取 fixture → 损坏后拒绝且原字节不变", async () => {
	const root = mkdtempSync(join(tmpdir(), "bios-selfcheck-store-"));
	try {
		const created = await initializeKnowledgeStore({ root });
		if (created.status !== "created") throw new Error(`首次初始化应创建，实际：${created.status}`);

		// 自建脱敏 fixture：一个最小的合法经验卡。
		const now = Date.now();
		const card = {
			schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION,
			revision: 0,
			createdAt: now,
			updatedAt: now,
			id: "exp-selfcheck",
			problem: "自检用的占位问题",
			rootCause: "自检用的占位根因",
			solution: "自检用的占位方案",
			appliesWhen: [],
			doesNotApplyWhen: [],
			sourceProjectId: "3f2504e0-4f89-4a1c-9a3d-1f0d3c9a4b7e",
			evidence: [],
			validations: [],
			reuseScope: { level: "internal-general", customers: [] },
			status: "draft",
		};
		const recordPath = join(root, ...recordRelativeSegments("experience-card", card.id));
		writeFileSync(recordPath, `${JSON.stringify(card, null, "\t")}\n`, "utf8");

		const readBack = await readRecord({ root, kind: "experience-card", id: card.id });
		if (readBack.record.id !== card.id) throw new Error("读回的记录 ID 不一致");

		// 损坏保护：破坏文件后必须拒绝，且原字节保持不变。
		writeFileSync(recordPath, "{ broken", "utf8");
		const before = createHash("sha256").update(readFileSync(recordPath)).digest("hex");
		let rejected = false;
		try {
			await readRecord({ root, kind: "experience-card", id: card.id });
		} catch (error) {
			rejected = error instanceof StorageError && error.code === "invalid-json";
		}
		if (!rejected) throw new Error("损坏记录未被拒绝");
		const after = createHash("sha256").update(readFileSync(recordPath)).digest("hex");
		if (before !== after) throw new Error("拒绝读取时改动了原文件");

		return "初始化 / 读取 / 损坏拒绝 / 原字节不变 均符合预期";
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

const knowledgeRoot = resolveKnowledgeRoot();
const knowledgePaths = resolveKnowledgePaths(knowledgeRoot);

console.log(`${BIOS_AGENT_PACKAGE_NAME}@${BIOS_AGENT_PACKAGE_VERSION}`);
console.log(`contracts schemaVersion: ${BIOS_CONTRACTS_SCHEMA_VERSION}`);
console.log(`知识根: ${knowledgePaths.root}（来源: ${knowledgeRoot.source}）`);
console.log(`  registry: ${knowledgePaths.registryPath}`);
console.log(`  projects: ${knowledgePaths.projectsDir}`);
console.log("");

let failed = 0;
for (const item of checks) {
	console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.label}  —  ${item.detail}`);
	if (!item.ok) failed += 1;
}

console.log("");
console.log(failed === 0 ? `全部通过（${checks.length} 项）` : `失败 ${failed} / ${checks.length} 项`);
process.exitCode = failed === 0 ? 0 : 1;
