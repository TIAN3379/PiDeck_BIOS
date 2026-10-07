/**
 * D1 验收支点：在**全新 Node 进程**里重开一份已持久化的 Pi 会话，并发一次新用户请求。
 *
 * 为什么必须另起进程：同进程里 SDK 重开会保留模块级内存状态（请求键序号、预算、耐久标记
 * 的内存视图），"重启后请求键碰撞"这类缺陷在进程内根本复现不出来。这里只做一件事：
 * 打开真实 session JSONL → 发一次脚本化的新请求 → 打印真实 provider 请求数与补记指令数。
 *
 * 用法：`node piSessionRestartChild.mjs '<json>'`，json = { workspaceA, sessionPath, env, prompt }。
 * 末尾输出一行 `RESTART-RESULT <json>`（避免与宿主日志混在一起）。
 */
import { pathToFileURL } from "node:url";
import { PI_MODULE_ENTRY } from "./biosExtension.mjs";
import { withSession } from "./piSessionHarness.mjs";

const input = JSON.parse(process.argv[2]);
const pi = await import(pathToFileURL(PI_MODULE_ENTRY).href);
const manager = pi.SessionManager.open(input.sessionPath);
/** 第一次请求做一次真实只读工具调用，其余（含补记阶段）回文本——与父进程第一轮的脚本保持一致。 */
const respond = (_body, index) => (index === 0 ? { toolCallId: `restart-investigate-${index}`, toolCall: { name: "bios_get_project_info", arguments: {} } } : { text: "SYNTHETIC restart answer" });

await withSession(
	{ workspaceA: input.workspaceA },
	input.env,
	respond,
	async ({ session, requests }) => {
		await session.prompt(input.prompt);
		const instructions = requests.filter((request) => JSON.stringify(request.body?.messages ?? []).includes("[BIOS 自动化补记]")).length;
		console.log(`RESTART-RESULT ${JSON.stringify({ requests: requests.length, instructions })}`);
	},
	{ sessionManager: manager },
);
process.exit(0);
