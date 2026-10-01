/**
 * 加载链路测试：证明本包能被 Pi 真实装载、工具可用、Skills 可发现。
 *
 * 三条独立证据：
 * 1. SDK 层：用 Pi 导出的 `discoverAndLoadExtensions` 加载扩展入口，断言工具已注册，
 *    并直接调用 `execute` 验证行为（离线，不启动会话、不连模型）；
 * 2. CLI 层：`pi -e <包目录>` 以 RPC 模式启动后关闭 stdin，确认退出码与加载诊断；
 * 3. RPC 层：隔离配置（临时 cwd + `PI_CODING_AGENT_DIR`）后下发 `get_commands`，
 *    断言两个 BIOS Skills 可见**且宿主自带技能没有混进来**。
 *
 * 依赖策略（round1_acceptance.md R5）：宿主包由本包自己的 devDependency 安装，
 * 不再写死开发机的绝对路径。宿主缺失时**测试失败并给出安装指引**，
 * 不用 skip 把"没验证"伪装成"通过"（`PI_CODING_AGENT_ROOT` 可显式指定宿主目录）。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXTENSION_ENTRY = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
const LOCAL_HOST_ROOT = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent", import.meta.url));

const HOST_MISSING_MESSAGE = "未找到 Pi 宿主包。请先在 packages/bios-agent 下执行 `npm install`（README「安装与自检」一节），或用环境变量 PI_CODING_AGENT_ROOT 指向 @earendil-works/pi-coding-agent 包目录。";

/** 宿主定位：环境变量优先，其次包内安装位置；**不**依赖开发机的兄弟目录。 */
function resolvePiFile(relativePath) {
	const roots = [process.env.PI_CODING_AGENT_ROOT, LOCAL_HOST_ROOT].filter((value) => typeof value === "string" && value.length > 0);
	for (const root of roots) {
		const candidate = join(root, relativePath);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

const PI_MODULE_ENTRY = resolvePiFile("dist/index.js");
const PI_CLI_ENTRY = resolvePiFile("dist/bundle/cli.js");

function makeTempDir(prefix) {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** RPC 子进程封装：处理 error / exit / 超时 / 输出上限，避免测试挂死或吞掉诊断。 */
function runRpcCommand({ args, cwd, env, command, timeoutMs = 60_000, maxOutputBytes = 1_000_000, maxStderrBytes = 200_000 }) {
	return new Promise((resolve, reject) => {
		// `--mode rpc` 必须在这里统一加上：缺了它 Pi 会以默认（非 RPC）模式启动，
		// 于是永远不会回响应，测试只会以超时收场。
		const child = spawn(process.execPath, [PI_CLI_ENTRY, "--mode", "rpc", ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });

		let buffer = "";
		let outputBytes = 0;
		let stderr = "";
		let settled = false;
		let response;
		let code;

		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (!error) {
				resolve({ code, stderr, response });
				return;
			}
			child.kill();
			// 等进程真正退出再上抛：Windows 上刚被 kill 的子进程可能仍短暂持有
			// 工作目录句柄，过早上抛会让调用方清理临时目录时拿到 EPERM。
			if (child.exitCode !== null || child.signalCode !== null) {
				reject(error);
				return;
			}
			const fallback = setTimeout(() => reject(error), 5_000);
			child.once("exit", () => {
				clearTimeout(fallback);
				reject(error);
			});
		};

		const timer = setTimeout(() => finish(new Error(`RPC 命令超时（${timeoutMs}ms）：${command}`)), timeoutMs);

		child.on("error", (error) => finish(error));
		// 用 `close` 而不是 `exit` 收尾：close 表示 stdout/stderr 已排空，
		// 此时收集到的 stderr 才是完整的（exit 可能早于最后的诊断输出）。
		child.on("close", (exitCode) => {
			code = exitCode;
			// 进程结束仍未拿到响应：明确失败，而不是当作"没有输出=通过"。
			if (response === undefined) {
				finish(new Error(`进程在返回 ${command} 响应前结束（code=${exitCode}）：${stderr.slice(0, 500)}`));
				return;
			}
			finish(undefined);
		});

		child.stderr.on("data", (chunk) => {
			// stderr 同样要有上限：宿主在启动失败时可能持续输出诊断。
			if (Buffer.byteLength(stderr) > maxStderrBytes) {
				finish(new Error(`RPC stderr 超过上限（${maxStderrBytes} 字节）`));
				return;
			}
			stderr += chunk;
		});
		child.stdout.on("data", (chunk) => {
			outputBytes += chunk.length;
			if (outputBytes > maxOutputBytes) {
				finish(new Error(`RPC 输出超过上限（${maxOutputBytes} 字节）`));
				return;
			}
			buffer += chunk;
			let index = buffer.indexOf("\n");
			while (index >= 0) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf("\n");
				if (!line.trim()) continue;
				try {
					const record = JSON.parse(line);
					if (record?.type === "response" && record.command === command) response = record;
				} catch {
					// 非 JSON 行不是协议记录（stdout 只放协议数据），忽略即可。
				}
			}
			if (response !== undefined) child.stdin.end();
		});

		// 写入时进程可能已退出（EPIPE）：这类错误由 close/超时路径给出结论，
		// 不在这里抛，避免未处理的 stream error 让整个测试进程崩掉。
		child.stdin.on("error", () => undefined);
		child.stdin.write(`${JSON.stringify({ id: "req-1", type: command })}\n`);
	});
}

async function loadExtensionTools() {
	assert.ok(PI_MODULE_ENTRY, HOST_MISSING_MESSAGE);
	const pi = await import(pathToFileURL(PI_MODULE_ENTRY).href);
	// agentDir 指向空目录：隔离宿主已安装的个人扩展，保证断言只针对本包。
	const agentDir = makeTempDir("bios-agent-load-");
	try {
		const result = await pi.discoverAndLoadExtensions([EXTENSION_ENTRY], PACKAGE_ROOT, agentDir);
		return { result, agentDir };
	} catch (error) {
		rmSync(agentDir, { recursive: true, force: true });
		throw error;
	}
}

test("Pi 加载器能装载本包扩展，且只注册一个入口与一个工具", async () => {
	const { result, agentDir } = await loadExtensionTools();
	try {
		assert.deepEqual(result.errors, [], "扩展加载不应产生错误");
		assert.equal(result.extensions.length, 1, "只应有一个自动加载入口");
		const tools = result.extensions.flatMap((extension) => [...extension.tools.keys()]);
		assert.deepEqual(tools, ["bios_detect_project"]);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("bios_detect_project：统计线索、忽略 VCS/依赖目录、给出资料缺口", async () => {
	const { result, agentDir } = await loadExtensionTools();
	const projectDir = makeTempDir("bios-agent-project-");
	try {
		writeFileSync(join(projectDir, "Platform.dsc"), "");
		writeFileSync(join(projectDir, "Platform.inf"), "");
		mkdirSync(join(projectDir, "nested"));
		writeFileSync(join(projectDir, "nested", "Board.asl"), "");
		mkdirSync(join(projectDir, ".git"));
		writeFileSync(join(projectDir, ".git", "Ignored.inf"), "");
		mkdirSync(join(projectDir, "node_modules"));
		writeFileSync(join(projectDir, "node_modules", "Ignored.inf"), "");

		const definition = result.extensions[0].tools.get("bios_detect_project").definition;
		const outcome = await definition.execute("call-1", {}, undefined, undefined, { cwd: projectDir });

		assert.equal(outcome.details.status, "unknown", "本轮不做身份判定");
		assert.equal(outcome.details.hintCounts[".dsc"], 1);
		assert.equal(outcome.details.hintCounts[".inf"], 1, "忽略目录里的线索不得计入");
		assert.equal(outcome.details.hintCounts[".asl"], 1);
		assert.equal(outcome.details.truncated, false);
		assert.ok(outcome.details.gaps.length > 0, "必须显式给出资料缺口");
		assert.match(outcome.content[0].text, /unknown/);
		assert.match(outcome.content[0].text, /资料缺口/);
		// 授权信息必须可复核：会话工作目录就是默认授权根。
		assert.equal(outcome.details.authorization.matchedRoot, outcome.details.targetDir);
	} finally {
		rmSync(projectDir, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("bios_detect_project：授权范围外的 targetDir 被拒绝，且不返回任何线索", async () => {
	const { result, agentDir } = await loadExtensionTools();
	const workspace = makeTempDir("bios-agent-ws-");
	const outside = makeTempDir("bios-agent-outside-");
	try {
		// 在范围外放一个明显的线索文件：如果实现先扫描后授权，就会泄漏它的样例路径。
		writeFileSync(join(outside, "Secret.dsc"), "");
		const definition = result.extensions[0].tools.get("bios_detect_project").definition;

		await assert.rejects(
			() => definition.execute("call-1", { targetDir: outside }, undefined, undefined, { cwd: workspace }),
			(error) => error?.code === "outside-authorized-roots",
		);
		// 子目录仍然可用（拒绝的是"越界"，不是"用参数指定目录"）。
		mkdirSync(join(workspace, "PlatformPkg"));
		const allowed = await definition.execute("call-2", { targetDir: "PlatformPkg" }, undefined, undefined, { cwd: workspace });
		assert.equal(allowed.details.targetDir, join(workspace, "PlatformPkg"));
	} finally {
		rmSync(workspace, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("bios_detect_project：适配层注入的额外授权根可用（模型无法自行扩权）", async () => {
	const { result, agentDir } = await loadExtensionTools();
	const workspace = makeTempDir("bios-agent-ws2-");
	const extraRoot = makeTempDir("bios-agent-extra-");
	const previous = process.env.BIOS_AUTHORIZED_ROOTS;
	try {
		writeFileSync(join(extraRoot, "Extra.dsc"), "");
		process.env.BIOS_AUTHORIZED_ROOTS = extraRoot;
		const definition = result.extensions[0].tools.get("bios_detect_project").definition;
		const outcome = await definition.execute("call-1", { targetDir: extraRoot }, undefined, undefined, { cwd: workspace });
		assert.equal(outcome.details.authorization.matchedRoot, outcome.details.targetDir);
		assert.equal(outcome.details.hintCounts[".dsc"], 1);
	} finally {
		if (previous === undefined) delete process.env.BIOS_AUTHORIZED_ROOTS;
		else process.env.BIOS_AUTHORIZED_ROOTS = previous;
		rmSync(workspace, { recursive: true, force: true });
		rmSync(extraRoot, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("CLI 能以 -e <包目录> 加载本包且无加载诊断", async () => {
	assert.ok(PI_CLI_ENTRY, HOST_MISSING_MESSAGE);
	const cwd = makeTempDir("bios-agent-cli-cwd-");
	const agentDir = makeTempDir("bios-agent-cli-agent-");
	try {
		const { code, stderr } = await runRpcCommand({
			args: ["--no-session", "--no-context-files", "--no-approve", "--no-extensions", "-e", PACKAGE_ROOT],
			cwd,
			env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir },
			command: "get_commands",
		});
		assert.equal(code, 0, `CLI 退出码应为 0；stderr：${stderr}`);
		assert.doesNotMatch(stderr, /Failed to load extension/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("隔离配置下 get_commands 能看到两个 BIOS Skills，且宿主技能未混入", async () => {
	assert.ok(PI_CLI_ENTRY, HOST_MISSING_MESSAGE);
	const cwd = makeTempDir("bios-agent-rpc-cwd-");
	const agentDir = makeTempDir("bios-agent-rpc-agent-");
	try {
		const { response, stderr } = await runRpcCommand({
			args: ["--no-session", "--no-context-files", "--no-approve", "--no-extensions", "-e", PACKAGE_ROOT],
			cwd,
			env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir },
			command: "get_commands",
		});
		assert.equal(response?.success, true, `get_commands 应成功；stderr：${stderr}`);
		const commands = response.data?.commands ?? [];
		const names = commands.map((command) => command?.name ?? String(command));
		const skills = names.filter((name) => String(name).startsWith("skill:"));

		assert.ok(skills.includes("skill:bios-project-onboarding"), `实际技能：${skills.join(", ")}`);
		assert.ok(skills.includes("skill:customer-feature-porting"), `实际技能：${skills.join(", ")}`);
		// 隔离证据：桌面端装进个人配置目录的技能不应出现（出现即说明隔离没生效）。
		assert.ok(!skills.includes("skill:image-gen"), `隔离配置未生效，宿主技能混入：${skills.join(", ")}`);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("RPC 子进程超时会被终止并报错（不挂死测试）", async () => {
	assert.ok(PI_CLI_ENTRY, HOST_MISSING_MESSAGE);
	const cwd = makeTempDir("bios-agent-timeout-");
	try {
		// 极短超时：进程还在启动阶段就会被终止，验证超时路径本身可用。
		await assert.rejects(
			() =>
				runRpcCommand({
					args: ["--no-session", "--no-context-files", "--no-approve"],
					cwd,
					env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: cwd },
					command: "get_commands",
					timeoutMs: 1,
				}),
			/timeoutMs|超时|结束/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("工具层：真实 AbortSignal 取消会让检测失败，而不是返回成功结果（round2 F3）", async () => {
	const { result, agentDir } = await loadExtensionTools();
	const projectDir = makeTempDir("bios-agent-cancel-");
	try {
		writeFileSync(join(projectDir, "Platform.dsc"), "");
		const definition = result.extensions[0].tools.get("bios_detect_project").definition;

		const controller = new AbortController();
		// 工具调用已同步推进到 probe 的第一个 await；此刻取消必须让整次调用失败，
		// 而不是返回一份"扫描了 1 个路径"的成功结果。
		const pending = definition.execute("call-1", {}, controller.signal, undefined, { cwd: projectDir });
		controller.abort();
		await assert.rejects(
			() => pending,
			(error) => error?.code === "cancelled" || /取消/.test(String(error?.message ?? error)),
		);
	} finally {
		rmSync(projectDir, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});
