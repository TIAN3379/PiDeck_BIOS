/**
 * BM-02D1：payload（内存原始字节）与清单的一致性核验。
 *
 * 关键纪律：hash 与字节长度一律用 `node:crypto` / `Buffer` **独立重算**，
 * 不拿实现自己的字段互证；成功只表示"清单协议合法且与所给字节一致"，
 * **不表示**业务能读、已导出或可以立即恢复。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { verifyBackupPayload } from "../core/storage/index.ts";
import { clone, fileEntriesFor, manifestFor, minimalEntries, minimalManifest, richDirectories, richEntries, richManifest, sha256Hex, utf8 } from "./helpers/backupFixtures.mjs";

const HEX = "0".repeat(64);
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * 在**独立子进程**里包装 `node:crypto` 的 `createHash`，统计核验期间真实发生的 hash 调用次数。
 *
 * 为什么必须另起进程：`verify.ts` 在模块加载时就绑定了 `createHash`，进程内事后替换
 * `crypto.createHash` 对它无效（与预检计量同一教训）；包装只计数并转发真实实现，
 * 不改变字节、长度或顺序。fixture 与期望 hash 在**计量开始前**就准备好，避免把构造工作计入。
 */
function verifyWithHashMeter({ manifest, limits, byteCase, payloadBase64, ownByteLength, sentinel = 3 }) {
	const script = `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const crypto = require("node:crypto");
const realCreateHash = crypto.createHash;
const config = JSON.parse(process.env.BACKUP_HASH_METER);
let hashCalls = 0;
crypto.createHash = (...args) => {
	hashCalls += 1;
	return realCreateHash(...args);
};
const { verifyBackupPayload } = await import(config.entryUrl);
const payload = Buffer.from(config.payloadBase64, "base64");
let bytes;
if (config.byteCase === "buffer") {
	bytes = payload;
} else if (config.byteCase === "own-byte-length") {
	bytes = payload;
	Object.defineProperty(bytes, "byteLength", { value: config.ownByteLength });
} else if (config.byteCase === "fake-prototype") {
	bytes = Object.create(Uint8Array.prototype);
	Object.defineProperty(bytes, "byteLength", { value: config.ownByteLength });
} else if (config.byteCase === "subarray") {
	// 视图前后各放哨兵字节：hash 只能覆盖视图区间，不能带上 backing buffer 的邻居。
	const backing = Buffer.concat([Buffer.alloc(config.sentinel, 0x58), payload, Buffer.alloc(config.sentinel, 0x59)]);
	bytes = backing.subarray(config.sentinel, config.sentinel + payload.byteLength);
} else {
	throw new Error("unknown byteCase");
}
const result = verifyBackupPayload(config.manifest, [{ path: "registry.json", bytes }], config.limits);
process.stdout.write(JSON.stringify({ hashCalls, result }));
`;
	const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
		cwd: PACKAGE_ROOT,
		env: {
			...process.env,
			BACKUP_HASH_METER: JSON.stringify({ manifest, limits, byteCase, payloadBase64, ownByteLength, sentinel, entryUrl: pathToFileURL(join(PACKAGE_ROOT, "core/storage/backup/index.ts")).href }),
		},
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	return JSON.parse(stdout);
}

/** 单文件清单（声明字节数由调用方给出，便于构造"声明与真实视图不符"的负例）。 */
function singleFileManifest(declaredBytes, sha256) {
	return manifestFor([{ path: "registry.json", bytes: declaredBytes, sha256 }], { directories: richDirectories() });
}

function expectFailure(manifest, entries, overrides) {
	const result = verifyBackupPayload(manifest, entries, overrides);
	assert.equal(result.ok, false, `本用例必须失败：${JSON.stringify(result)}`);
	return result;
}

function expectCode(manifest, entries, overrides, code) {
	const result = expectFailure(manifest, entries, overrides);
	assert.ok(
		result.issues.some((issue) => issue.code === code),
		`期望问题码 ${code}，实际 ${JSON.stringify(result.issues)}`,
	);
	return result;
}

/** 单文件清单 + 对应字节（用于把失败点钉在 payload 上）。 */
function singleFileFixture(path, bytes, overrides) {
	return { manifest: manifestFor([{ path, bytes: bytes.byteLength, sha256: sha256Hex(bytes) }], { directories: richDirectories(), ...overrides }), entries: [{ path, bytes }] };
}

/* ------------------------------------------------------------------ 1. 通过路径 */

test("D1：payload 与清单一致时通过（顺序无关、逐项独立重算）", async (t) => {
	await t.test("全落点 payload：条目数与总字节都用独立口径重算", () => {
		const entries = richEntries();
		const result = verifyBackupPayload(richManifest(), entries);
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.files, entries.length);
		assert.equal(
			result.totalBytes,
			entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.bytes), 0),
		);
	});

	await t.test("最小 payload：空目录清单 + 单文件", () => {
		const result = verifyBackupPayload(minimalManifest(), minimalEntries());
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.files, 1);
	});

	await t.test("顺序无关：payload 打乱后仍然通过", () => {
		const result = verifyBackupPayload(richManifest(), [...richEntries()].reverse());
		assert.equal(result.ok, true, JSON.stringify(result));
	});

	await t.test("空 payload 文件（长度 0）合法", () => {
		const empty = utf8("");
		assert.equal(empty.byteLength, 0);
		assert.equal(sha256Hex(empty), createHash("sha256").digest("hex"), "空字节的 hash 必须等于独立重算值");
		const fixture = singleFileFixture("registry.json", empty, { directories: richDirectories() });
		const result = verifyBackupPayload(fixture.manifest, fixture.entries);
		// 只有 registry.json 一条，且 directories 覆盖必需目录 ⇒ 通过。
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.totalBytes, 0);
	});

	await t.test("字节一致即可通过：未来业务版本与损坏 JSON 都不做业务准入（本轮明确不做）", () => {
		// 这条对照是**刻意**的：hash 相符不代表当前应用能解释内容，防止后续把字节一致误当"可恢复"。
		const future = utf8('{"schemaVersion":999,"payload":');
		const broken = utf8("not json at all");
		const manifest = manifestFor(
			[
				{ path: "registry.json", bytes: future.byteLength, sha256: sha256Hex(future) },
				{ path: "experiences/exp-a.json", bytes: broken.byteLength, sha256: sha256Hex(broken) },
			],
			{ directories: richDirectories() },
		);
		const result = verifyBackupPayload(manifest, [
			{ path: "registry.json", bytes: future },
			{ path: "experiences/exp-a.json", bytes: broken },
		]);
		assert.equal(result.ok, true, "字节一致即通过；业务版本闸门由 D2/D3 负责");
	});

	await t.test("不写调用者数据：payload 数组与字节内容都不变", () => {
		const entries = richEntries();
		const manifest = richManifest();
		const entriesBefore = entries.map((entry) => Buffer.from(entry.bytes));
		const manifestBefore = clone(manifest);
		assert.equal(verifyBackupPayload(manifest, entries).ok, true);
		assert.deepEqual(manifest, manifestBefore, "清单不得被改写");
		entries.forEach((entry, index) => {
			assert.deepEqual(Buffer.from(entry.bytes), entriesBefore[index], "字节内容不得被改写");
			assert.equal(entry.bytes.byteLength, entriesBefore[index].byteLength, "字节长度不得被改写");
		});
	});

	await t.test("原始字节保真：BOM / CRLF / 制表符 / 尾空格 / 非法 UTF-8 都原样参与核验，不经 stringify 改写", () => {
		// 这条钉的是"payload 走原始字节，而不是 decode → 字符串 → 编码"：
		// BOM、CRLF、行尾空白与**不是合法 UTF-8** 的字节都必须逐字节进入 hash。
		const core = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('{"schemaVersion":1}\r\n'), utf8("\t  trailing  \n"), Buffer.from([0xff, 0xfe, 0x00, 0x80])]);
		const original = Buffer.concat([core, utf8(" ")]);
		const hash = sha256Hex(original);

		const manifest = manifestFor([{ path: "registry.json", bytes: original.byteLength, sha256: hash }], { directories: richDirectories() });
		const entry = { path: "registry.json", bytes: original };
		const result = verifyBackupPayload(manifest, [entry]);
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.totalBytes, original.byteLength, "总字节必须等于原始字节长度（含 BOM 与非法 UTF-8 序列）");
		assert.equal(Buffer.compare(entry.bytes, original), 0, "调用后字节必须逐字节不变");
		assert.equal(sha256Hex(entry.bytes), hash, "重算 hash 必须仍等于按原文独立计算的 hash");

		// 反向对照：只差一个**尾空格**字节就已经不是同一份复制（空白不是"可忽略差异"）。
		assert.equal(core.byteLength, original.byteLength - 1);
		const mismatch = verifyBackupPayload(manifest, [{ path: "registry.json", bytes: core }]);
		assert.equal(mismatch.ok, false);
		assert.ok(
			mismatch.issues.some((issue) => issue.code === "payload-size-mismatch"),
			JSON.stringify(mismatch.issues),
		);
	});
});

/* ------------------------------------------------------------------ 2. 不一致的各类形态 */

test("D1：缺失 / 多余 / 重复 / 长度错 / hash 错都必须失败", async (t) => {
	await t.test("清单声明的文件缺席", () => {
		const entries = richEntries();
		expectCode(richManifest(), entries.slice(1), undefined, "payload-missing");
	});

	await t.test("payload 含清单未声明的路径", () => {
		const entries = [...richEntries(), { path: "experiences/exp-b.json", bytes: utf8("{}") }];
		const result = expectCode(richManifest(), entries, undefined, "payload-unknown-path");
		assert.equal(JSON.stringify(result.issues).includes("exp-b"), false, "诊断不得回显路径原文");
	});

	await t.test("同名条目重复：既报重复也报缺席", () => {
		const entries = richEntries();
		// 用第一条顶掉第二条 ⇒ 既有一条重复，也有一条清单声明却缺席。
		const duplicated = [entries[0], entries[0], ...entries.slice(2)];
		const result = expectCode(richManifest(), duplicated, undefined, "payload-duplicate");
		assert.ok(
			result.issues.some((issue) => issue.code === "payload-missing"),
			JSON.stringify(result.issues),
		);
	});

	await t.test("长度正确但 hash 不符", () => {
		const declared = utf8("AAAA");
		const actual = utf8("BBBB");
		assert.equal(actual.byteLength, declared.byteLength, "本用例必须长度相等，才能证明是 hash 判据拦住它");
		const fixture = singleFileFixture("registry.json", declared, { directories: richDirectories() });
		expectCode(fixture.manifest, [{ path: "registry.json", bytes: actual }], undefined, "payload-hash-mismatch");
	});

	await t.test("长度与清单声明不符", () => {
		const fixture = singleFileFixture("registry.json", utf8("AAAA"), { directories: richDirectories() });
		expectCode(fixture.manifest, [{ path: "registry.json", bytes: utf8("AA") }], undefined, "payload-size-mismatch");
	});

	await t.test("中文与换行差异不被归一化（等长但不同字节即 hash 不符）", () => {
		const declared = utf8("经验"); // 与"經驗"等长（各 6 字节 UTF-8）
		const otherChinese = utf8("經驗");
		assert.equal(otherChinese.byteLength, declared.byteLength);
		const fixture = singleFileFixture("registry.json", declared, { directories: richDirectories() });
		expectCode(fixture.manifest, [{ path: "registry.json", bytes: otherChinese }], undefined, "payload-hash-mismatch");

		const lf = utf8("A\nB");
		const cr = utf8("A\rB");
		assert.equal(cr.byteLength, lf.byteLength, "换行差异用例必须等长");
		const crlfFixture = singleFileFixture("registry.json", lf, { directories: richDirectories() });
		expectCode(crlfFixture.manifest, [{ path: "registry.json", bytes: cr }], undefined, "payload-hash-mismatch");
	});
});

/* ------------------------------------------------------------------ 3. 严格输入与限额 */

test("D1：payload 严格输入、清单前置校验与限额", async (t) => {
	await t.test("entries 不是数组 / 条目不是对象 / 字节类型不对", () => {
		expectCode(richManifest(), {}, undefined, "payload-entry");
		expectCode(richManifest(), [null], undefined, "payload-entry");
		expectCode(richManifest(), ["registry.json"], undefined, "payload-entry");
		expectCode(richManifest(), [{ path: 1, bytes: utf8("{}") }], undefined, "payload-entry");
		// 字符串与数字数组都不是"原始字节"：不做隐式编码转换。
		expectCode(richManifest(), [{ path: "registry.json", bytes: "{}" }], undefined, "payload-entry");
		expectCode(richManifest(), [{ path: "registry.json", bytes: [123, 125] }], undefined, "payload-entry");
	});

	await t.test("条目存在未知字段", () => {
		const entries = [{ ...richEntries()[0], note: "x" }, ...richEntries().slice(1)];
		expectCode(richManifest(), entries, undefined, "unknown-field");
	});

	await t.test("清单本身无效时先失败，且失败码来自清单校验", () => {
		const notObject = expectFailure([], [], undefined);
		assert.equal(notObject.code, "invalid-backup-manifest");
		assert.ok(notObject.issues.some((issue) => issue.code === "not-object"));

		const incomplete = richManifest({ backupVersion: 7 });
		const second = expectFailure(incomplete, richEntries(), undefined);
		assert.equal(second.code, "invalid-backup-manifest");
		assert.ok(
			second.issues.some((issue) => issue.code === "invalid-version"),
			JSON.stringify(second.issues),
		);
	});

	await t.test("条目数超过预算（清单本身仍在预算内）", () => {
		const manifest = minimalManifest();
		const entries = Array.from({ length: 11 }, () => ({ path: "registry.json", bytes: utf8("{}") }));
		expectCode(manifest, entries, { maxFiles: 10 }, "too-many-files");
	});

	await t.test("maxIssues=0：不返回问题但如实计数且仍是失败", () => {
		const result = expectFailure(richManifest(), [{ path: "experiences/exp-b.json", bytes: utf8("{}") }], { maxIssues: 0 });
		assert.deepEqual(result.issues, []);
		assert.ok(result.droppedIssues >= 1);
		assert.equal(result.code, "backup-payload-mismatch");
	});

	await t.test("非法限额在处理数据前抛出", () => {
		assert.throws(
			() => verifyBackupPayload(richManifest(), richEntries(), { maxFiles: Number.NaN }),
			(error) => error?.code === "invalid-limits",
		);
		assert.throws(
			() => verifyBackupPayload(richManifest(), richEntries(), { unknownLimit: 1 }),
			(error) => error?.code === "invalid-limits",
		);
	});

	await t.test("hash 由独立 createHash 复算（实现字段不参与互证）", () => {
		const entries = richEntries();
		for (const entry of entries) {
			assert.equal(sha256Hex(entry.bytes), createHash("sha256").update(entry.bytes).digest("hex"));
		}
		for (const file of fileEntriesFor(entries)) {
			assert.equal(file.sha256.length, 64);
			assert.equal(file.sha256, file.sha256.toLowerCase());
		}
		assert.notEqual(HEX, richManifest().files[0].sha256);
	});
});

/* ------------------------------------------------------------------ 4. D1R / B1：真实视图品牌与实际长度 */

test("D1R/B1：字节品牌与实际长度必须来自真实视图，且先于 hash 判定", async (t) => {
	await t.test("原复现：真实两字节视图覆盖自有 byteLength=1，声明与单文件/总预算均为 1 ⇒ 受控失败且不计算 hash", () => {
		const actual = Buffer.from([65, 66]);
		const measured = verifyWithHashMeter({
			manifest: singleFileManifest(1, sha256Hex(actual)),
			limits: { maxFileBytes: 1, maxTotalPayloadBytes: 1 },
			byteCase: "own-byte-length",
			payloadBase64: actual.toString("base64"),
			ownByteLength: 1,
		});
		assert.equal(measured.result.ok, false, `必须受控失败，不得返回总量 1 的成功：${JSON.stringify(measured.result)}`);
		assert.equal(measured.result.code, "backup-payload-mismatch");
		assert.ok(
			measured.result.issues.some((issue) => issue.code === "payload-size-mismatch"),
			JSON.stringify(measured.result.issues),
		);
		assert.equal(measured.hashCalls, 0, "已知长度失败不得再计算 hash");
	});

	await t.test("对照：同一视图不覆盖 byteLength 时结论一致（真实长度 2 ≠ 声明 1）", () => {
		const actual = Buffer.from([65, 66]);
		const measured = verifyWithHashMeter({
			manifest: singleFileManifest(1, sha256Hex(actual)),
			limits: { maxFileBytes: 1, maxTotalPayloadBytes: 1 },
			byteCase: "buffer",
			payloadBase64: actual.toString("base64"),
		});
		assert.equal(measured.result.ok, false);
		assert.ok(
			measured.result.issues.some((issue) => issue.code === "payload-size-mismatch"),
			JSON.stringify(measured.result.issues),
		);
		assert.equal(measured.hashCalls, 0);
	});

	await t.test("原型伪装视图：受控失败，不抛原始 crypto 异常", () => {
		const fake = Object.create(Uint8Array.prototype);
		Object.defineProperty(fake, "byteLength", { value: 1 });
		const result = verifyBackupPayload(singleFileManifest(1, HEX), [{ path: "registry.json", bytes: fake }], { maxFileBytes: 1, maxTotalPayloadBytes: 1 });
		assert.equal(result.ok, false, `必须受控失败：${JSON.stringify(result)}`);
		assert.ok(
			result.issues.some((issue) => issue.code === "payload-entry"),
			JSON.stringify(result.issues),
		);
	});

	await t.test("正常 Buffer / 非零偏移子视图 / 空文件保持通过，摘要与总量只算视图覆盖的字节", () => {
		const core = utf8('{"a":1}');

		const bufferCase = verifyWithHashMeter({ manifest: singleFileManifest(core.byteLength, sha256Hex(core)), byteCase: "buffer", payloadBase64: core.toString("base64") });
		assert.equal(bufferCase.result.ok, true, JSON.stringify(bufferCase.result));
		assert.equal(bufferCase.result.totalBytes, core.byteLength);
		assert.equal(bufferCase.hashCalls, 1, "合法 payload 只计算一次 hash");

		const subarray = verifyWithHashMeter({ manifest: singleFileManifest(core.byteLength, sha256Hex(core)), byteCase: "subarray", payloadBase64: core.toString("base64"), sentinel: 3 });
		assert.equal(subarray.result.ok, true, JSON.stringify(subarray.result));
		assert.equal(subarray.result.totalBytes, core.byteLength, "总量必须只算视图覆盖的字节，不含前后哨兵");
		assert.equal(subarray.hashCalls, 1);

		const empty = Buffer.alloc(0);
		const emptyCase = verifyWithHashMeter({ manifest: singleFileManifest(0, sha256Hex(empty)), byteCase: "buffer", payloadBase64: "" });
		assert.equal(emptyCase.result.ok, true, JSON.stringify(emptyCase.result));
		assert.equal(emptyCase.result.totalBytes, 0);
		assert.equal(emptyCase.hashCalls, 1, "空文件也要真实计算一次 hash");
	});
});
