/**
 * R29-3 永久回归：**真实业务 CLI 的提交事实**与选项语义。
 *
 * 覆盖：
 * - journal 终态 rename 故障（通过预加载 loader hook 注入）时，写入仍发布但 CLI 必须退出 8，
 *   且不得干净成功、不得回滚已提交数据；
 * - `--status` 不依赖 `--family`（不再被静默忽略），未知状态显式拒绝；
 * - 缺少来源授权时读取命令缺省拒绝。
 *
 * 全部使用自建临时知识库与合成内容；不读任何真实客户资料。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { initializeKnowledgeStore, readRecord } from "../core/storage/index.ts";
import { bindProjectWorkspace } from "../core/projects/index.ts";
import { createExperienceDraft, reviewExperience } from "../core/knowledge/index.ts";
import { createProjectSandbox, PACKAGE_ROOT, writeDsc } from "./helpers/projectFixtures.mjs";

const NOW = 1_700_000_000_000;
const BUSINESS_CLI = join(PACKAGE_ROOT, "cli", "business.mjs");
const FAULT_PRELOAD = pathToFileURL(join(PACKAGE_ROOT, "tests", "helpers", "journalFaultPreload.mjs")).href;

/** @returns {{ code: number, stdout: string, json: Record<string, any> | null }} */
function runBusiness(args, { preload } = {}) {
	const nodeArgs = [...(preload === undefined ? [] : ["--import", preload]), BUSINESS_CLI, ...args];
	try {
		const stdout = execFileSync(process.execPath, nodeArgs, { cwd: PACKAGE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
		return { code: 0, stdout, json: parseJson(stdout) };
	} catch (error) {
		const failure = /** @type {{ status?: number, stdout?: string }} */ (error);
		const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
		return { code: typeof failure.status === "number" ? failure.status : 1, stdout, json: parseJson(stdout) };
	}
}

/** @returns {Record<string, any> | null} */
function parseJson(stdout) {
	const lines = stdout.trim().split("\n");
	for (const line of lines.reverse()) {
		try {
			return JSON.parse(line);
		} catch {
			// 继续往前找单对象 JSON 行。
		}
	}
	return null;
}

async function sandbox() {
	const sb = await createProjectSandbox("bm05-writefacts-");
	await initializeKnowledgeStore({ root: sb.root, now: NOW });
	await writeDsc(sb.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformA" });
	await mkdir(sb.workspaceB, { recursive: true });
	const projectA = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA, sb.workspaceB], workspacePath: sb.workspaceA, now: NOW });
	return { ...sb, projectA };
}

test("R29-3：journal 终态故障的真实 CLI 仍保留已提交事实，但退出 8 而不是干净成功", async () => {
	const sb = await sandbox();
	try {
		const args = ["feature-create", "--root", sb.root, "--json", "--feature-id", "feat-fault", "--requirement", "客户要求关闭 PXE 以缩短启动时间", "--alias", "PXE", "--write"];
		const faulted = runBusiness(args, { preload: FAULT_PRELOAD });

		assert.equal(faulted.code, 8, `journal 终态故障必须退出 8（实际 ${faulted.code}）：${faulted.stdout}`);
		assert.equal(faulted.json?.status, "created", "数据提交点已过：必须报 created，不能回滚或谎报失败");
		assert.equal(faulted.json?.code, "needs-review");
		assert.ok((faulted.json?.needsReview ?? []).length > 0, "必须如实给出需要人工核对的事实");
		assert.ok(
			(faulted.json?.needsReview ?? []).some((reason) => /journal/.test(reason)),
			"需要核对项要提到 journal 终态",
		);

		// 已提交事实必须真的在库里（exit 8 不等于没写）。
		const stored = await readRecord({ root: sb.root, kind: "feature-record", id: "feat-fault" });
		assert.equal(stored.record.originalRequirement, "客户要求关闭 PXE 以缩短启动时间");

		// 正常路径（无故障）是干净成功；重复创建是 revision 冲突（4），不是 needs-review。
		const clean = runBusiness(["feature-create", "--root", sb.root, "--json", "--feature-id", "feat-clean", "--requirement", "正常的第二条需求", "--write"]);
		assert.equal(clean.code, 0);
		assert.equal(clean.json?.needsReview?.length ?? 0, 0);
		const duplicate = runBusiness(["feature-create", "--root", sb.root, "--json", "--feature-id", "feat-clean", "--requirement", "重复", "--write"]);
		assert.equal(duplicate.code, 4, "重复创建必须是 revision 冲突");
	} finally {
		await sb.cleanup();
	}
});

test("R29-3：`--status` 独立于 `--family`，未知状态显式拒绝", async () => {
	const sb = await sandbox();
	try {
		const draft = await createExperienceDraft({
			root: sb.root,
			authorizedProjectIds: [sb.projectA.projectId],
			experience: { experienceId: "exp-status", problem: "PXE 默认开启导致启动变慢", rootCause: "默认值", solution: "关闭默认值", sourceProjectId: sb.projectA.projectId, reuse: { level: "current-project" } },
			now: NOW,
		});
		assert.equal(draft.status, "created");
		await reviewExperience({ root: sb.root, authorizedProjectIds: [sb.projectA.projectId], experienceId: "exp-status", expectedRevision: draft.revision, action: "submit-review", operatorLabel: "engineer", reason: "可复用", now: NOW + 1 });

		const base = ["search", "--root", sb.root, "--json", "--query", "PXE", "--authorized-project", sb.projectA.projectId, "--target-project", sb.projectA.projectId];
		// 不给 --family，只给 --status：必须真正生效（reviewed 命中、draft 不命中）。
		const reviewedOnly = runBusiness([...base, "--status", "reviewed"]);
		assert.equal(reviewedOnly.json?.hits?.length, 1, `--status 必须独立生效：${reviewedOnly.stdout}`);
		assert.equal(reviewedOnly.json?.hits?.[0]?.recordedStatus, "reviewed");

		const draftOnly = runBusiness([...base, "--status", "draft"]);
		assert.equal(draftOnly.json?.hits?.length, 0, "draft 过滤必须真的过滤掉 reviewed");

		const unknown = runBusiness([...base, "--status", "not-a-status"]);
		assert.equal(unknown.code, 2, "未知状态必须用法错误，而不是被静默忽略");
		assert.equal(unknown.json?.code, "invalid-argument");
	} finally {
		await sb.cleanup();
	}
});

test("R29-1：读取命令缺省拒绝来源授权（不给/给错都不返回内容）", async () => {
	const sb = await sandbox();
	try {
		await createExperienceDraft({
			root: sb.root,
			authorizedProjectIds: [sb.projectA.projectId],
			experience: { experienceId: "exp-deny", problem: "PXE 默认开启导致启动变慢", rootCause: "默认值", solution: "关闭默认值", sourceProjectId: sb.projectA.projectId },
			now: NOW,
		});
		const withoutAuthorization = runBusiness(["experience-show", "--root", sb.root, "--json", "--experience-id", "exp-deny"]);
		assert.equal(withoutAuthorization.code, 2, "不给 --authorized-project 必须在读取前拒绝");
		assert.doesNotMatch(withoutAuthorization.stdout, /默认值/);

		const wrongProject = runBusiness(["experience-show", "--root", sb.root, "--json", "--experience-id", "exp-deny", "--authorized-project", "00000000-0000-4000-8000-000000000000"]);
		assert.equal(wrongProject.code, 3, "给错来源项目必须是受控拒绝（exit 3）");
		assert.equal(wrongProject.json?.status, "not-authorized");
		assert.doesNotMatch(wrongProject.stdout, /默认值/, "拒绝时不得泄漏正文");
	} finally {
		await sb.cleanup();
	}
});
