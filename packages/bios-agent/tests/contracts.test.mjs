/**
 * 数据契约测试：结构与版本闸门。
 *
 * 只依赖 core/contracts（纯数据层，无 Electron／React／Pi Session），
 * 因此用 Node 原生 type stripping 直接 import `.ts` 即可，不需要构建产物。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { BIOS_CONTRACTS_SCHEMA_VERSION, BiosContractError, RECORD_SCHEMAS, assertWritableRecord, describeIssues, inspectKnowledgeId, validateRecord, validateRecordByKind } from "../core/contracts/index.ts";

const NOW = 1_700_000_000_000;
/** 稳定项目 ID 用 UUID（不能用目录名或 Session ID 代替）。 */
const PROJECT_ID = "3f2504e0-4f89-4a1c-9a3d-1f0d3c9a4b7e";
const OTHER_PROJECT_ID = "8c1b2f44-6a5d-4b3e-9f7a-2d4c8e1b5a90";
const WORKSPACE_ID = "b7d1e9f2-3c4a-4d5e-8f9a-0b1c2d3e4f50";
const WORKSPACE_ID_TWO = "c8e2f0a3-4d5b-4e6f-9a0b-1c2d3e4f5061";

/** 完整对象工厂：避免用 `as` 或部分对象绕过类型约束（AGENTS.md 测试写法要求）。 */
function field(value, status = "candidate") {
	return { value, status, evidence: [], updatedAt: NOW };
}

function identity() {
	return {
		ibv: field("Example IBV"),
		ibvVersion: field("1.2.3"),
		chipsetVendor: field("Example Vendor"),
		chipsetFamily: field("Example Family"),
		chipsetGeneration: field("Gen-1"),
		architecture: field("x86_64"),
		boardName: field("ExampleBoard"),
		boardRevision: field("A1"),
		customer: field("Example Customer"),
		productLine: field("Example Line"),
		crbBaseline: field("CRB-1.0"),
	};
}

function base(overrides = {}) {
	return { schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION, revision: 0, createdAt: NOW, updatedAt: NOW, ...overrides };
}

function workspaceBinding(overrides = {}) {
	return {
		workspaceId: WORKSPACE_ID,
		path: "D:/work/bios-main",
		availability: "reachable",
		vcs: { kind: "git", branch: "main", head: "abc1234", remoteUrl: "https://example.invalid/bios.git" },
		capturedAt: NOW,
		...overrides,
	};
}

function makeProjectProfile(overrides = {}) {
	return {
		...base(),
		id: PROJECT_ID,
		identity: identity(),
		workspaces: [workspaceBinding()],
		buildTargets: [field("ExampleBoardPkg")],
		keyEntryPoints: [field("PlatformPkg/Platform.dsc")],
		gaps: [],
		...overrides,
	};
}

function makeTaskRecord(overrides = {}) {
	return {
		...base(),
		id: "task-1",
		projectId: PROJECT_ID,
		workspace: { workspaceId: WORKSPACE_ID, path: "D:/work/bios-main", branch: "feature/x", baseCommit: "abc1234" },
		requirement: "支持 PXE 启动项在客户 OOB 菜单中的可见性调整",
		status: "in_progress",
		decisions: ["沿用现有 PXE 驱动，不改动网络栈"],
		todos: ["确认目标构建目标"],
		blockers: [],
		relatedFiles: ["PlatformPkg/Library/PxeLib/PxeLib.inf"],
		sourceExperienceIds: [],
		validations: [],
		...overrides,
	};
}

function makeFeatureRecord(overrides = {}) {
	return {
		...base(),
		id: "feature-1",
		originalRequirement: "客户要求 PXE 与网络启动在 OS 安装完成后默认关闭",
		aliases: ["PXE", "网络启动", "NetworkBoot"],
		customer: field("Example Customer"),
		productLine: field("Example Line"),
		acceptanceCriteria: ["Setup 中默认关闭且可通过 F10 恢复"],
		relatedExperienceIds: [],
		...overrides,
	};
}

function makeExperienceCard(overrides = {}) {
	return {
		...base(),
		id: "exp-1",
		problem: "PXE 默认开启导致 OS 安装后仍尝试网络引导",
		rootCause: "Setup 默认值未随客户选项调整",
		solution: "在客户定制区覆盖默认值并补充恢复入口",
		appliesWhen: ["同一 IBV 主线且使用相同 Setup 架构"],
		doesNotApplyWhen: ["Setup 架构不同或客户要求保持默认开启"],
		sourceProjectId: OTHER_PROJECT_ID,
		evidence: [{ type: "source-file", projectId: OTHER_PROJECT_ID, workspaceId: WORKSPACE_ID, relativePath: "Setup/Setup.inf", location: "12-40", capturedAt: NOW, validity: "active" }],
		validations: [],
		reuseScope: { level: "customer", customers: ["Example Customer"], authorization: "客户已授权内部复用" },
		status: "reviewed",
		...overrides,
	};
}

function makeContextManifest(overrides = {}) {
	return {
		...base(),
		id: "ctx-1",
		targetProjectId: PROJECT_ID,
		taskId: "task-1",
		profileRevision: 3,
		sources: [{ recordId: "exp-1", recordKind: "experience-card", revision: 2, reason: "与当前需求同族且客户授权复用" }],
		expiredSources: [],
		budget: { maxChars: 12_000, maxBytes: 24_576, usedChars: 1_024, truncated: false },
		generatedAt: NOW,
		...overrides,
	};
}

test("五类记录的最小合法样例都能通过校验", () => {
	const cases = [
		["project-profile", makeProjectProfile()],
		["task-record", makeTaskRecord()],
		["feature-record", makeFeatureRecord()],
		["experience-card", makeExperienceCard()],
		["context-manifest", makeContextManifest()],
	];
	for (const [kind, record] of cases) {
		const outcome = validateRecordByKind(kind, record);
		assert.equal(outcome.ok, true, `${kind} 应当通过：${outcome.ok ? "" : describeIssues(outcome.issues)}`);
	}
	// schema 表必须覆盖全部 kind，避免新增记录后忘记登记校验入口。
	assert.deepEqual(Object.keys(RECORD_SCHEMAS).sort(), cases.map(([kind]) => kind).sort());
});

test("必填字段缺失被拒绝，并且错误路径指向缺失字段", () => {
	const broken = makeProjectProfile();
	delete broken.identity.chipsetFamily;
	const outcome = validateRecordByKind("project-profile", broken);
	assert.equal(outcome.ok, false);
	assert.ok(outcome.issues.some((issue) => issue.path.includes("identity")));
});

test("枚举越界被拒绝（字段三态与任务状态）", () => {
	const badStatus = makeProjectProfile();
	badStatus.identity.ibv.status = "probably";
	assert.equal(validateRecordByKind("project-profile", badStatus).ok, false);

	const badTaskStatus = makeTaskRecord({ status: "finished" });
	assert.equal(validateRecordByKind("task-record", badTaskStatus).ok, false);
});

test("ExperienceCard 审核状态只接受四态", () => {
	// 四个合法状态都必须通过：状态机是人工审核的门禁，不能靠"没报错"默认放行。
	for (const status of ["draft", "reviewed", "verified", "deprecated"]) {
		assert.equal(validateRecordByKind("experience-card", makeExperienceCard({ status })).ok, true, status);
	}
	assert.equal(validateRecordByKind("experience-card", makeExperienceCard({ status: "approved" })).ok, false);
});

test("项目 ID 必须是 UUID：目录名或 Session ID 形态会被拒绝", () => {
	const asDirectoryName = makeProjectProfile({ id: "bios-main" });
	assert.equal(validateRecordByKind("project-profile", asDirectoryName).ok, false);
	const asUppercaseUuid = makeProjectProfile({ id: PROJECT_ID.toUpperCase() });
	assert.equal(validateRecordByKind("project-profile", asUppercaseUuid).ok, false);
	assert.equal(validateRecordByKind("project-profile", makeProjectProfile()).ok, true);
});

test("两个 worktree 各自保存 branch/HEAD，互不覆盖", () => {
	const profile = makeProjectProfile({
		workspaces: [
			workspaceBinding({ workspaceId: WORKSPACE_ID, path: "D:/work/bios-main", vcs: { kind: "git", branch: "main", head: "aaaa111", remoteUrl: null } }),
			workspaceBinding({ workspaceId: WORKSPACE_ID_TWO, path: "D:/work/bios-wt", vcs: { kind: "git", branch: "feature/pxe", head: "bbbb222", remoteUrl: null } }),
		],
	});
	const outcome = validateRecordByKind("project-profile", profile);
	assert.equal(outcome.ok, true);
	assert.equal(profile.workspaces[0].vcs.branch, "main");
	assert.equal(profile.workspaces[1].vcs.branch, "feature/pxe");
	// 同一份档案里两个工作区必须可区分：workspaceId 是关联 Task/Evidence 的键。
	assert.notEqual(profile.workspaces[0].workspaceId, profile.workspaces[1].workspaceId);
});

test("无 Git 的工作区：省略 vcs，用 availability 表达状态", () => {
	const profile = makeProjectProfile({
		workspaces: [workspaceBinding({ vcs: undefined, availability: "reachable" })],
	});
	assert.equal(validateRecordByKind("project-profile", profile).ok, true);

	// 目录暂时不可达只改 availability，不删除绑定。
	const missing = makeProjectProfile({ workspaces: [workspaceBinding({ availability: "missing", vcs: undefined })] });
	assert.equal(validateRecordByKind("project-profile", missing).ok, true);

	// 非法的可达状态要被拒绝（避免自由字符串混进来）。
	const bogus = makeProjectProfile({ workspaces: [workspaceBinding({ availability: "offline" })] });
	assert.equal(validateRecordByKind("project-profile", bogus).ok, false);
});

test("工作区标识也必须是 UUID", () => {
	const bogus = makeProjectProfile({ workspaces: [workspaceBinding({ workspaceId: "workspace-one" })] });
	assert.equal(validateRecordByKind("project-profile", bogus).ok, false);
});

test("记录 ID：schema 与运行时允许集合完全一致（含保留名的点后缀形式）", () => {
	// round2 F1：schema 的负向断言只排除"整个字符串等于保留名"时，
	// `con.json` 会通过 schema 却被运行时/路径层拒绝——两条链的允许集合必须相同。
	const deviceNames = ["con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9"];
	const rejected = [];
	for (const name of deviceNames) {
		rejected.push(name, `${name}.json`, `${name}.txt.bak`, `${name}.dsc`);
	}
	// 普通非法形态
	rejected.push("exp.", "exp..", "Exp", "a/b", "a\\b", "..", ".hidden", "a b");

	// 这些看起来像保留名但不是：不能被误杀（否则真实项目名会被无理由拒绝）。
	const accepted = ["exp-1", "exp-1.2", "console", "nullify", "com10", "lpt10", "com1x", "auxiliary", "printer", "con2"];

	for (const id of rejected) {
		const outcome = validateRecordByKind("experience-card", makeExperienceCard({ id }));
		assert.equal(outcome.ok, false, `schema 应拒绝：${id}`);
		assert.notEqual(inspectKnowledgeId(id), undefined, `运行时应拒绝：${id}`);
	}
	for (const id of accepted) {
		const outcome = validateRecordByKind("experience-card", makeExperienceCard({ id }));
		assert.equal(outcome.ok, true, `schema 应接受：${id}（${outcome.ok ? "" : describeIssues(outcome.issues)}）`);
		assert.equal(inspectKnowledgeId(id), undefined, `运行时应接受：${id}`);
	}
});

test("记录 ID：保留名被拒绝时错误码指向保留名而不是泛化的字符集", () => {
	// 允许集合一致之外，错误码仍需可操作：`con.json` 应说明是保留名问题。
	assert.equal(inspectKnowledgeId("con.json"), "reserved-name");
	assert.equal(inspectKnowledgeId("nul"), "reserved-name");
	assert.equal(inspectKnowledgeId("exp."), "trailing-dot");
	assert.equal(inspectKnowledgeId("Exp"), "charset");
});

test("更高的 schemaVersion 被拒绝写入", () => {
	const future = makeProjectProfile({ schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION + 1 });
	const outcome = validateRecordByKind("project-profile", future);
	assert.equal(outcome.ok, false);
	assert.equal(outcome.issues[0].code, "unsupported-schema-version");
});

test("缺失或非整数的 schemaVersion 报 invalid-schema-version", () => {
	const missing = makeProjectProfile();
	delete missing.schemaVersion;
	const missingOutcome = validateRecordByKind("project-profile", missing);
	assert.equal(missingOutcome.ok, false);
	assert.equal(missingOutcome.issues[0].code, "invalid-schema-version");

	const fractional = makeProjectProfile({ schemaVersion: 1.5 });
	const fractionalOutcome = validateRecordByKind("project-profile", fractional);
	assert.equal(fractionalOutcome.ok, false);
	assert.equal(fractionalOutcome.issues[0].code, "invalid-schema-version");
});

test("非对象输入不会被当成合法记录", () => {
	for (const value of [null, undefined, 42, "record", []]) {
		const outcome = validateRecord(RECORD_SCHEMAS["experience-card"], value);
		assert.equal(outcome.ok, false, String(value));
	}
});

test("assertWritableRecord 失败时抛结构化错误且带 code", () => {
	assert.throws(
		() => assertWritableRecord(RECORD_SCHEMAS["experience-card"], makeExperienceCard({ schemaVersion: 99 })),
		(error) => error instanceof BiosContractError && error.code === "unsupported-schema-version",
	);
});

test("describeIssues 输出包含错误码与路径，且限制条数", () => {
	const issues = Array.from({ length: 10 }, (_, index) => ({ code: "invalid-record", path: `/field${index}`, message: "must be string" }));
	const text = describeIssues(issues, 3);
	assert.match(text, /invalid-record/);
	assert.match(text, /\/field0/);
	assert.match(text, /另有 7 条问题/);
});
