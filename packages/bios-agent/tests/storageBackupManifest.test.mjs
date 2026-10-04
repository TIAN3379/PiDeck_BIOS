/**
 * BM-02D1：离线备份清单协议（`backupVersion=1`）的纯校验。
 *
 * 这一组用例钉死的不是"能通过多少清单"，而是**清单在什么情况下不可信**：
 * 严格字段/版本、受控落点、路径逃逸、跨数组冲突、资源预算与错误裁剪。
 * 全部使用合成内存对象：不读写用户库、不落盘、不引入业务格式升级。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { BACKUP_EXCLUDED_DIRECTORIES, BACKUP_LAYOUT_SEGMENTS, BACKUP_MANIFEST_FIELD_ORDER, BACKUP_MANIFEST_VERSION, BACKUP_REQUIRED_DIRECTORIES, DEFAULT_BACKUP_LIMITS, knowledgeLayout, measureBackupManifestBytes, resolveBackupLimits, validateBackupManifest } from "../core/storage/index.ts";
import { canonicalManifestBytes, clone, fileEntriesFor, manifestFor, minimalEntries, minimalManifest, NOW, OTHER_UUID, PROJECT_ID, RECORD_ID, richDirectories, richEntries, richManifest, THIRD_UUID } from "./helpers/backupFixtures.mjs";

/** 期望失败（失败码唯一：`invalid-backup-manifest`）。 */
function expectFailure(value, overrides) {
	const result = validateBackupManifest(value, overrides);
	assert.equal(result.ok, false, `本用例必须被拒绝：${JSON.stringify(value)}`);
	assert.equal(result.code, "invalid-backup-manifest");
	return result;
}

/** 期望失败且问题里含指定码。 */
function expectCode(value, overrides, code) {
	const result = expectFailure(value, overrides);
	assert.ok(
		result.issues.some((issue) => issue.code === code),
		`期望问题码 ${code}，实际 ${JSON.stringify(result.issues)}`,
	);
	return result;
}

function expectOk(value, overrides) {
	const result = validateBackupManifest(value, overrides);
	assert.equal(result.ok, true, `本用例必须通过：${JSON.stringify(result)}`);
	return result;
}

/** 只放一条文件项（用于把失败点钉在路径上）。 */
function manifestWithFileEntry(entry, directories = richDirectories()) {
	return manifestFor([entry], { directories });
}

const HEX = "0".repeat(64);
/** 含字母的合法小写 hash（大小写变体负例必须能真的变大写）。 */
const HEX_UPPER = "abcdef0123456789".repeat(4).toUpperCase();

/* ------------------------------------------------------------------ 1. 合法清单 */

test("D1：合法清单（最小 / 全落点 / 打乱顺序 / 字节口径）", async (t) => {
	await t.test("最小清单：只含 registry.json 与四个必需目录", () => {
		const result = expectOk(minimalManifest());
		assert.deepEqual(Object.keys(result.manifest), [...BACKUP_MANIFEST_FIELD_ORDER], "规范化清单字段顺序必须固定（字节预算据此可复现）");
		assert.deepEqual(result.manifest.directories, [...BACKUP_REQUIRED_DIRECTORIES]);
		assert.deepEqual(result.manifest.exclusions, [...BACKUP_EXCLUDED_DIRECTORIES]);
		assert.equal(result.manifest.backupVersion, BACKUP_MANIFEST_VERSION);
		assert.deepEqual(result.manifest, minimalManifest(), "不得增删字段或改变取值");
	});

	await t.test("全落点清单：五类记录 + 普通/审核 journal + 意图/事件 + 空目录共存", () => {
		const result = expectOk(richManifest());
		assert.equal(result.manifest.files.length, richEntries().length);
		assert.deepEqual(result.manifest.directories, richDirectories());
	});

	await t.test("exclusions 只比较集合，顺序不影响结果", () => {
		const result = expectOk(minimalManifest({ exclusions: ["locks", "cache"] }));
		assert.deepEqual(result.manifest.exclusions, [...BACKUP_EXCLUDED_DIRECTORIES]);
	});

	await t.test("数组顺序不是有效性的前提：打乱 files 与 directories 仍然通过", () => {
		const manifest = richManifest();
		const result = expectOk({ ...manifest, directories: [...manifest.directories].reverse(), files: [...manifest.files].reverse() });
		const byPath = (left, right) => (left.path < right.path ? -1 : 1);
		assert.deepEqual([...result.manifest.files].sort(byPath), [...manifest.files].sort(byPath), "顺序变化不得改变条目内容");
	});

	await t.test("规范化字节口径可复现：等于独立重算，且与输入键序无关", () => {
		const manifest = richManifest();
		const reordered = { files: manifest.files, directories: manifest.directories, exclusions: manifest.exclusions, consistency: manifest.consistency, createdAt: manifest.createdAt, backupId: manifest.backupId, backupVersion: manifest.backupVersion };
		const first = expectOk(manifest);
		const second = expectOk(reordered);
		assert.equal(measureBackupManifestBytes(first.manifest), canonicalManifestBytes(manifest), "字节口径必须等于独立重算的规范化序列化字节");
		assert.equal(measureBackupManifestBytes(second.manifest), measureBackupManifestBytes(first.manifest), "输入键序不同不得改变规范化字节数");
	});

	await t.test("不写调用者数据：成功与失败路径都不改写输入", () => {
		const value = richManifest();
		const before = clone(value);
		expectOk(value);
		assert.deepEqual(value, before, "成功路径不得改写输入");

		const broken = richManifest({ backupId: "Not-A-Legal-Id" });
		const brokenBefore = clone(broken);
		expectFailure(broken);
		assert.deepEqual(broken, brokenBefore, "失败路径也不得改写输入");
	});

	await t.test("受控落点表与存储层布局同名（漂移守卫）", () => {
		// 只提供 `knowledgeLayout` 需要的三个成员：不建目录、不碰真实根。
		const layout = knowledgeLayout({ root: "/k", canonicalRoot: "/k", resolve: (...segments) => ["/k", ...segments].join("/") });
		const basename = (value) => value.split("/").pop();
		assert.equal(basename(layout.registryPath), BACKUP_LAYOUT_SEGMENTS.registryFile);
		assert.equal(basename(layout.projectsDir), BACKUP_LAYOUT_SEGMENTS.projectsDir);
		assert.equal(basename(layout.experiencesDir), BACKUP_LAYOUT_SEGMENTS.experiencesDir);
		assert.equal(basename(layout.featuresDir), BACKUP_LAYOUT_SEGMENTS.featuresDir);
		assert.equal(basename(layout.auditDir), BACKUP_LAYOUT_SEGMENTS.auditDir);
		assert.equal(basename(layout.journalDir), BACKUP_LAYOUT_SEGMENTS.journalDir);
		assert.equal(`${BACKUP_LAYOUT_SEGMENTS.auditDir}/${BACKUP_LAYOUT_SEGMENTS.intentDir}`, "audit/intents");
		assert.deepEqual([...BACKUP_REQUIRED_DIRECTORIES], [BACKUP_LAYOUT_SEGMENTS.projectsDir, BACKUP_LAYOUT_SEGMENTS.experiencesDir, BACKUP_LAYOUT_SEGMENTS.featuresDir, BACKUP_LAYOUT_SEGMENTS.auditDir]);
	});
});

/* ------------------------------------------------------------------ 2. 严格结构与版本 */

test("D1：严格字段与版本（不做尽力解释）", async (t) => {
	await t.test("非普通对象一律拒绝（数组 / null / 类实例 / 自定义原型）", () => {
		for (const value of [null, [], "manifest", 42, new Date(NOW), Object.assign(Object.create({ extra: true }), minimalManifest())]) {
			expectCode(value, undefined, "not-object");
		}
	});

	await t.test("缺版本 / 未来版本 / 版本类型错误", () => {
		const withoutVersion = minimalManifest();
		delete withoutVersion.backupVersion;
		expectCode(withoutVersion, undefined, "missing-field");
		expectCode(minimalManifest({ backupVersion: 2 }), undefined, "invalid-version");
		expectCode(minimalManifest({ backupVersion: "1" }), undefined, "invalid-version");
	});

	await t.test("缺字段逐个报出；未知字段拒绝且不回显字段名与值", () => {
		for (const key of ["backupId", "createdAt", "consistency", "exclusions", "directories", "files"]) {
			const value = minimalManifest();
			delete value[key];
			expectCode(value, undefined, "missing-field");
		}

		const result = expectCode({ ...minimalManifest(), customerName: "示例客户A" }, undefined, "unknown-field");
		const serialized = JSON.stringify(result.issues);
		assert.equal(serialized.includes("示例客户A"), false, "诊断不得回显未知字段的值");
		assert.equal(serialized.includes("customerName"), false, "诊断不得回显未知字段名");

		const withSymbol = minimalManifest();
		withSymbol[Symbol("extra")] = 1;
		expectCode(withSymbol, undefined, "unknown-field");
	});

	await t.test("consistency 必须是 offline-copy（更强的标记也不接受）", () => {
		expectCode(minimalManifest({ consistency: "online" }), undefined, "invalid-consistency");
		expectCode(minimalManifest({ consistency: "atomic" }), undefined, "invalid-consistency");
	});

	await t.test("exclusions 必须恰好是 cache + locks（不缺、不多、不重复）", () => {
		expectCode(minimalManifest({ exclusions: ["cache"] }), undefined, "invalid-exclusions");
		expectCode(minimalManifest({ exclusions: ["cache", "locks", "journal"] }), undefined, "invalid-exclusions");
		expectCode(minimalManifest({ exclusions: ["cache", "cache", "locks"] }), undefined, "invalid-exclusions");
		expectCode(minimalManifest({ exclusions: "cache,locks" }), undefined, "invalid-exclusions");
	});

	await t.test("backupId 与 createdAt 的范围／类型", () => {
		expectCode(minimalManifest({ backupId: "" }), undefined, "invalid-backup-id");
		expectCode(minimalManifest({ backupId: "Backup-1" }), undefined, "invalid-backup-id");
		expectCode(minimalManifest({ backupId: "con" }), undefined, "invalid-backup-id");
		for (const createdAt of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1700000000000", 8_640_000_000_000_001]) {
			expectCode(minimalManifest({ createdAt }), undefined, "invalid-created-at");
		}
		expectOk(minimalManifest({ createdAt: 0 }));
	});

	await t.test("files / directories 不是数组", () => {
		expectCode(minimalManifest({ files: {} }), undefined, "not-array");
		expectCode(minimalManifest({ directories: "projects" }), undefined, "not-array");
	});

	await t.test("文件项严格字段、bytes 与 sha256 形态", () => {
		expectCode(manifestWithFileEntry({ path: "registry.json", bytes: 0, sha256: HEX, note: "x" }), undefined, "unknown-field");
		expectCode(manifestWithFileEntry("registry.json"), undefined, "not-object");
		for (const bytes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "0", null]) {
			expectCode(manifestWithFileEntry({ path: "registry.json", bytes, sha256: HEX }), undefined, "invalid-bytes");
		}
		for (const sha256 of [HEX_UPPER, "0".repeat(63), "0".repeat(65), `${HEX}z`, 0, null]) {
			expectCode(manifestWithFileEntry({ path: "registry.json", bytes: 0, sha256 }), undefined, "invalid-hash");
		}
		expectOk(manifestWithFileEntry({ path: "registry.json", bytes: 0, sha256: HEX }));
	});
});

/* ------------------------------------------------------------------ 3. 路径逃逸与规范形式 */

test("D1：路径必须是规范受控相对路径（不 normalize 危险输入）", async (t) => {
	const escapes = [
		["绝对路径", "/etc/passwd.json"],
		["盘符路径", "C:/data/registry.json"],
		["UNC 路径", "//server/share/registry.json"],
		["反斜杠", "experiences\\exp-a.json"],
		["父目录段", "experiences/../registry.json"],
		["当前目录段", "experiences/./exp-a.json"],
		["重复分隔符", "experiences//exp-a.json"],
		["尾分隔符", "experiences/exp-a.json/"],
		["NUL 字符", "experiences/exp-a.json\u0000"],
		["冒号 / ADS", "experiences/exp-a.json:stream"],
		["URL 编码未解码", "experiences/%2e%2e/exp-a.json"],
		["尾点", "experiences/exp-a.json."],
		["尾空格", "experiences/exp-a.json "],
		["大小写变体", "Experiences/exp-a.json"],
		["设备保留名", "experiences/con.json"],
		["非 ASCII", "experiences/经验-a.json"],
		["非字符串", 123],
		["空串", ""],
	];

	for (const [label, path] of escapes) {
		await t.test(`拒绝${label}`, () => {
			expectCode(manifestWithFileEntry({ path, bytes: 0, sha256: HEX }), undefined, "invalid-path");
		});
	}

	await t.test("路径字符数超限（差一即拒；用完全合法的长路径构造边界）", () => {
		// 受控 ID 上限是 128，因此用"深一层的合法路径"把长度做到 186 才够到路径预算边界。
		const long = `projects/${PROJECT_ID}/context/${"a".repeat(127)}.json`;
		assert.equal(long.length, 186);
		const value = manifestFor(
			[
				{ path: "registry.json", bytes: 0, sha256: HEX },
				{ path: long, bytes: 0, sha256: HEX },
			],
			{ directories: richDirectories() },
		);
		expectOk(value, { maxRelativePathChars: long.length });
		expectCode(value, { maxRelativePathChars: long.length - 1 }, "invalid-path");
	});

	await t.test("诊断不回显恶意路径原文", () => {
		const result = expectCode(manifestWithFileEntry({ path: "../../secret/客户A/registry.json", bytes: 0, sha256: HEX }), undefined, "invalid-path");
		const serialized = JSON.stringify(result.issues);
		assert.equal(serialized.includes("客户A"), false);
		assert.equal(serialized.includes("secret"), false);
	});
});

/* ------------------------------------------------------------------ 4. 受控落点 */

test("D1：只接受受控落点（未知落点 / 名字不符 / 目录混用）", async (t) => {
	const unknownLandings = ["custom/x.json", "cache/scratch.json", "locks/lock-0123456789abcdef0123456789abcdef.json", "manifest.json", "experiences/nested/x.json", "audit/intents.json"];
	for (const path of unknownLandings) {
		await t.test(`未知落点：${path}`, () => {
			expectCode(manifestWithFileEntry({ path, bytes: 0, sha256: HEX }), undefined, "unknown-landing");
		});
	}

	const badNames = [
		["记录目录里的非 JSON", "experiences/exp-a.tmp", "invalid-file-name"],
		["记录目录里的隐藏文件", "experiences/.hidden.json", "invalid-file-name"],
		["记录 ID 以点结尾", "experiences/exp-a..json", "invalid-file-name"],
		["journal 非 UUID", "journal/not-a-uuid.json", "invalid-file-name"],
		["意图非 UUID", "audit/intents/not-a-uuid.json", "invalid-file-name"],
		["项目目录非 UUID", "projects/not-a-uuid/profile.json", "invalid-file-name"],
		["任务 ID 路径逃逸", `projects/${PROJECT_ID}/tasks/../x.json`, "invalid-path"],
		["事件 ID 非 UUID", `audit/${RECORD_ID}/not-a-uuid.json`, "invalid-file-name"],
	];
	for (const [label, path, code] of badNames) {
		await t.test(`名字不符合既有规则：${label}`, () => {
			expectCode(manifestWithFileEntry({ path, bytes: 0, sha256: HEX }), undefined, code);
		});
	}

	await t.test("合法落点逐类通过（含 audit/intents 与事件目录的区分）", () => {
		const files = [
			{ path: "registry.json", bytes: 0, sha256: HEX },
			{ path: `projects/${PROJECT_ID}/profile.json`, bytes: 0, sha256: HEX },
			{ path: `projects/${PROJECT_ID}/tasks/task-1.json`, bytes: 0, sha256: HEX },
			{ path: `projects/${PROJECT_ID}/context/ctx-1.json`, bytes: 0, sha256: HEX },
			{ path: "experiences/exp-a.json", bytes: 0, sha256: HEX },
			{ path: "features/feat-1.json", bytes: 0, sha256: HEX },
			{ path: `journal/${OTHER_UUID}.json`, bytes: 0, sha256: HEX },
			{ path: `audit/intents/${THIRD_UUID}.json`, bytes: 0, sha256: HEX },
			{ path: `audit/${RECORD_ID}/${OTHER_UUID}.json`, bytes: 0, sha256: HEX },
		];
		expectOk(manifestFor(files, { directories: richDirectories() }));
	});

	await t.test("目录落点：未知目录、混用与缺失祖先", () => {
		expectCode(manifestFor(fileEntriesFor(minimalEntries()), { directories: ["custom", ...BACKUP_REQUIRED_DIRECTORIES] }), undefined, "unknown-landing");
		expectCode(manifestFor(fileEntriesFor(minimalEntries()), { directories: ["experiences/exp-a.json", ...BACKUP_REQUIRED_DIRECTORIES] }), undefined, "unknown-landing");
		expectCode(manifestFor(fileEntriesFor(minimalEntries()), { directories: ["projects/not-a-uuid", ...BACKUP_REQUIRED_DIRECTORIES] }), undefined, "invalid-file-name");
		// 子目录的父目录必须登记：`projects/<id>/tasks` 没有 `projects/<id>`。
		expectCode(manifestFor(fileEntriesFor(minimalEntries()), { directories: [`projects/${PROJECT_ID}/tasks`, ...BACKUP_REQUIRED_DIRECTORIES] }), undefined, "missing-ancestor");
		// 文件缺少 `experiences` 目录。
		expectCode(
			manifestFor(
				[
					{ path: "experiences/exp-a.json", bytes: 0, sha256: HEX },
					{ path: "registry.json", bytes: 0, sha256: HEX },
				],
				{ directories: ["projects", "features", "audit"] },
			),
			undefined,
			"missing-ancestor",
		);
	});

	await t.test("cache / locks 只出现在 exclusions 里，不得进入 data 清单", () => {
		expectCode(manifestFor(fileEntriesFor(minimalEntries()), { directories: ["cache", ...BACKUP_REQUIRED_DIRECTORIES] }), undefined, "unknown-landing");
		expectCode(manifestFor(fileEntriesFor(minimalEntries()), { directories: ["locks", ...BACKUP_REQUIRED_DIRECTORIES] }), undefined, "unknown-landing");
	});
});

/* ------------------------------------------------------------------ 5. 跨数组与布局一致性 */

test("D1：跨数组与布局一致性", async (t) => {
	await t.test("重复路径（files / directories 各自）", () => {
		const registry = { path: "registry.json", bytes: 0, sha256: HEX };
		expectCode(manifestFor([registry, registry], { directories: richDirectories() }), undefined, "duplicate-path");
		expectCode(manifestFor(fileEntriesFor(minimalEntries()), { directories: ["projects", "projects", "experiences", "features", "audit"] }), undefined, "duplicate-path");
	});

	await t.test("缺少 registry.json（含大小写变体的对照）", () => {
		expectCode(manifestFor([{ path: "experiences/exp-a.json", bytes: 0, sha256: HEX }], { directories: richDirectories() }), undefined, "missing-registry");
		expectCode(manifestFor([{ path: "REGISTRY.json", bytes: 0, sha256: HEX }], { directories: richDirectories() }), undefined, "invalid-path");
	});

	await t.test("缺少必需固定目录（逐个缺）", () => {
		for (const required of BACKUP_REQUIRED_DIRECTORIES) {
			const directories = BACKUP_REQUIRED_DIRECTORIES.filter((name) => name !== required);
			expectCode(manifestFor(fileEntriesFor(minimalEntries()), { directories }), undefined, "missing-required-directory");
		}
	});
});

/* ------------------------------------------------------------------ 6. 资源限额与错误裁剪 */

test("D1：资源限额（0 / 恰好足够 / 差一 / 溢出 / 错误裁剪）", async (t) => {
	const manifest = richManifest();
	const files = manifest.files;
	const directories = manifest.directories;
	const longestPath = Math.max(...files.map((file) => file.path.length));
	const largestFile = Math.max(...files.map((file) => file.bytes));
	const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
	const manifestBytes = canonicalManifestBytes(manifest);

	await t.test("maxFiles：恰好足够通过，差一拒绝", () => {
		expectOk(manifest, { maxFiles: files.length });
		expectCode(manifest, { maxFiles: files.length - 1 }, "too-many-files");
		expectCode(manifest, { maxFiles: 0 }, "too-many-files");
	});

	await t.test("maxDirectories：恰好足够通过，差一拒绝", () => {
		expectOk(manifest, { maxDirectories: directories.length });
		expectCode(manifest, { maxDirectories: directories.length - 1 }, "too-many-directories");
		expectCode(manifest, { maxDirectories: 0 }, "too-many-directories");
	});

	await t.test("maxFileBytes：恰好足够通过，差一拒绝", () => {
		expectOk(manifest, { maxFileBytes: largestFile });
		expectCode(manifest, { maxFileBytes: largestFile - 1 }, "file-too-large");
	});

	await t.test("maxTotalPayloadBytes：恰好足够通过，差一拒绝", () => {
		expectOk(manifest, { maxTotalPayloadBytes: totalBytes });
		expectCode(manifest, { maxTotalPayloadBytes: totalBytes - 1 }, "payload-too-large");
	});

	await t.test("maxRelativePathChars：恰好足够通过，差一拒绝", () => {
		expectOk(manifest, { maxRelativePathChars: longestPath });
		expectCode(manifest, { maxRelativePathChars: longestPath - 1 }, "invalid-path");
	});

	await t.test("maxManifestBytes：恰好足够通过，差一拒绝，0 明确拒绝", () => {
		expectOk(manifest, { maxManifestBytes: manifestBytes });
		expectCode(manifest, { maxManifestBytes: manifestBytes - 1 }, "manifest-too-large");
		expectCode(manifest, { maxManifestBytes: 0 }, "manifest-too-large");
	});

	await t.test("总字节累加在溢出前就拒绝（不做不安全运算）", () => {
		const half = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1;
		const huge = [
			{ path: "registry.json", bytes: half, sha256: HEX },
			{ path: "experiences/exp-a.json", bytes: half, sha256: HEX },
		];
		expectCode(manifestFor(huge, { directories: richDirectories() }), { maxFileBytes: Number.MAX_SAFE_INTEGER, maxTotalPayloadBytes: Number.MAX_SAFE_INTEGER, maxManifestBytes: Number.MAX_SAFE_INTEGER }, "payload-too-large");
	});

	await t.test("maxIssues：0 不返回问题但不误报成功；1 只返回一条且如实计数", () => {
		const broken = minimalManifest({ backupId: "", createdAt: -1, consistency: "online" });
		const zero = expectFailure(broken, { maxIssues: 0 });
		assert.deepEqual(zero.issues, [], "maxIssues=0 不返回问题对象");
		assert.ok(zero.droppedIssues >= 1, "但被丢弃的问题必须如实计数");
		assert.equal(zero.code, "invalid-backup-manifest", "预算耗尽不能变成成功");

		const one = expectFailure(broken, { maxIssues: 1 });
		assert.equal(one.issues.length, 1);
		assert.ok(one.droppedIssues >= 1);
	});

	await t.test("非法限额与未知限额字段在处理数据前抛 invalid-limits", () => {
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, "1000"]) {
			assert.throws(
				() => resolveBackupLimits({ maxFiles: value }),
				(error) => error?.code === "invalid-limits",
				`maxFiles=${String(value)}`,
			);
		}
		assert.throws(
			() => resolveBackupLimits({ maxFileSize: 10 }),
			(error) => error?.code === "invalid-limits",
			"未知限额字段必须拒绝",
		);
		assert.deepEqual(resolveBackupLimits({ maxFiles: undefined }), DEFAULT_BACKUP_LIMITS, "显式 undefined 保持默认");
	});
});

/* ------------------------------------------------------------------ 7. D1R / B2：排除条数先于元素访问 */

test("D1R/B2：exclusions 数量不等于两项时不访问元素", async (t) => {
	// 这一组**不能**经过 `expectFailure`：它的失败消息会 `JSON.stringify(value)`，
	// 那本身就是一次元素遍历，会把计量/哨兵污染成"实现访问了元素"。
	await t.test("0 / 1 / 3 / 100001 项都受控拒绝，且一次元素访问都没有发生", () => {
		for (const size of [0, 1, 3, 100_001]) {
			let elementAccesses = 0;
			const items = Array.from({ length: size }, () => "cache");
			const proxied = new Proxy(items, {
				get(target, key, receiver) {
					if (typeof key === "string" && /^[0-9]+$/.test(key)) elementAccesses += 1;
					return Reflect.get(target, key, receiver);
				},
			});
			const manifest = minimalManifest({ exclusions: proxied });
			const result = validateBackupManifest(manifest);
			assert.equal(result.ok, false, "数量不符必须受控失败");
			assert.ok(
				result.issues.some((issue) => issue.code === "invalid-exclusions"),
				JSON.stringify(result.issues),
			);
			assert.equal(elementAccesses, 0, `${size} 项时不得访问任何元素（数量边界必须先于遍历）`);
		}
	});

	await t.test("哨兵 getter 元素：数量不符时不得触发（旧实现会在这里抛原始异常）", () => {
		const items = ["cache", "locks", "extra"];
		Object.defineProperty(items, 1, {
			enumerable: true,
			configurable: true,
			get() {
				throw new Error("数量边界未生效：不允许访问元素");
			},
		});
		const result = validateBackupManifest(minimalManifest({ exclusions: items }));
		assert.equal(result.ok, false);
		assert.ok(
			result.issues.some((issue) => issue.code === "invalid-exclusions"),
			JSON.stringify(result.issues),
		);
	});

	await t.test("两项正序/反序继续通过；重复与未知成员继续拒绝；裁剪预算仍失败且不误报成功", () => {
		expectOk(minimalManifest({ exclusions: ["locks", "cache"] }));
		expectCode(minimalManifest({ exclusions: ["cache", "locks", "locks"] }), undefined, "invalid-exclusions");
		expectCode(minimalManifest({ exclusions: ["cache", "journal"] }), undefined, "invalid-exclusions");

		const zero = expectFailure(minimalManifest({ exclusions: [] }), { maxIssues: 0 });
		assert.deepEqual(zero.issues, []);
		assert.ok(zero.droppedIssues >= 1, "裁剪预算下仍要如实计数");
		const one = expectFailure(minimalManifest({ exclusions: [] }), { maxIssues: 1 });
		assert.equal(one.issues.length, 1);
	});

	await t.test("合法输入数组不被改写", () => {
		const items = ["locks", "cache"];
		const before = [...items];
		expectOk(minimalManifest({ exclusions: items }));
		assert.deepEqual(items, before);
	});
});
