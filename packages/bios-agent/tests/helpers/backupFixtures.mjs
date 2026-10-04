/**
 * BM-02D1 备份协议的**合成清单 fixture**（测试用，不读真实知识库、不落盘）。
 *
 * 一条纪律：hash 与字节长度一律用 `node:crypto` / `Buffer` **独立重算**，
 * 不拿实现自己的字段互证——否则"实现与自己一致"会掩盖"实现与规范不一致"。
 */
import { createHash } from "node:crypto";

export const NOW = 1_700_000_000_000;
export const PROJECT_ID = "3f2504e0-4f89-4a1c-9a3d-1f0d3c9a4b7e";
export const OTHER_UUID = "8c1b2f44-6a5d-4b3e-9f7a-2d4c8e1b5a90";
export const THIRD_UUID = "b7d1e9f2-3c4a-4d5e-8f9a-0b1c2d3e4f50";
/** 事件目录名 = 记录 ID（受控通用 ID，不是 UUID）。 */
export const RECORD_ID = "exp-a";

export function sha256Hex(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

export function utf8(text) {
	return Buffer.from(text, "utf8");
}

/** 文件项：路径 + **实际**字节数 + 实际字节的 SHA-256。 */
export function fileEntry(path, bytes) {
	return { path, bytes: bytes.byteLength, sha256: sha256Hex(bytes) };
}

/** 最小合法 payload：只有必需的 registry.json。 */
export function minimalEntries() {
	return [{ path: "registry.json", bytes: utf8('{"schemaVersion":1,"revision":0}\n') }];
}

/** 覆盖全部受控落点的 payload（五类记录 + 普通/审核 journal + 意图/事件 + 项目子目录）。 */
export function richEntries() {
	return [
		{ path: "registry.json", bytes: utf8('{"schemaVersion":1,"revision":1}\n') },
		{ path: `projects/${PROJECT_ID}/profile.json`, bytes: utf8(`{"id":"${PROJECT_ID}"}\n`) },
		{ path: `projects/${PROJECT_ID}/tasks/task-1.json`, bytes: utf8('{"requirement":"支持 PXE 开关"}\n') },
		{ path: `projects/${PROJECT_ID}/context/ctx-1.json`, bytes: utf8('{"taskId":"task-1"}\n') },
		{ path: "experiences/exp-a.json", bytes: utf8('{"problem":"PXE 默认开启"}\n') },
		{ path: "features/feat-1.json", bytes: utf8('{"originalRequirement":"客户定制引导顺序"}\n') },
		{ path: `journal/${OTHER_UUID}.json`, bytes: utf8('{"journalVersion":1,"state":"committed"}\n') },
		{ path: `audit/intents/${THIRD_UUID}.json`, bytes: utf8('{"auditIntentVersion":1}\n') },
		{ path: `audit/${RECORD_ID}/${OTHER_UUID}.json`, bytes: utf8('{"auditVersion":1}\n') },
	];
}

/** 与 `richEntries` 对应的目录列表（含必需固定目录与可选的 journal / audit/intents 空目录）。 */
export function richDirectories() {
	return ["projects", `projects/${PROJECT_ID}`, `projects/${PROJECT_ID}/tasks`, `projects/${PROJECT_ID}/context`, "experiences", "features", "journal", "audit", `audit/${RECORD_ID}`, "audit/intents"];
}

/** 最小合法目录列表：只含四个必需固定目录，其余为空即不登记。 */
export function minimalDirectories() {
	return ["projects", "experiences", "features", "audit"];
}

/** payload 条目 → 文件项数组。 */
export function fileEntriesFor(entries) {
	return entries.map((entry) => fileEntry(entry.path, entry.bytes));
}

/**
 * 按**契约字段顺序**构造清单。
 *
 * `files` 接收**已经成形的文件项**（而不是 payload 条目），这样负例可以直接放畸形条目进数组。
 */
export function manifestFor(files, overrides = {}) {
	const { directories, ...rest } = overrides;
	return {
		backupVersion: 1,
		backupId: "backup-1",
		createdAt: NOW,
		consistency: "offline-copy",
		exclusions: ["cache", "locks"],
		directories: directories ?? richDirectories(),
		files,
		...rest,
	};
}

/** 全落点清单（含可选的 journal / audit/intents 目录）。 */
export function richManifest(overrides = {}) {
	return manifestFor(fileEntriesFor(richEntries()), overrides);
}

/** 最小清单（只含 registry.json 与四个必需目录）。 */
export function minimalManifest(overrides = {}) {
	return manifestFor(fileEntriesFor(minimalEntries()), { directories: minimalDirectories(), ...overrides });
}

/** 独立重算清单序列化字节（与 `measureBackupManifestBytes` 同口径，但**不复用**实现）。 */
export function canonicalManifestBytes(manifest) {
	return Buffer.byteLength(JSON.stringify(manifest), "utf8");
}

/** 深拷贝（断言"输入不被改写"用）。 */
export function clone(value) {
	return JSON.parse(JSON.stringify(value));
}
