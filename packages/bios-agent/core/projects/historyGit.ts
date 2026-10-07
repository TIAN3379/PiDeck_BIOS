/** 有界本地 Git 读取；共享给桌面历史入口和 Pi 工具，禁止懒取远端/外部 diff。 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

export async function readHistoryGit(cwd: string, args: readonly string[], options: { executable?: string; maxBuffer?: number; signal?: AbortSignal } = {}): Promise<string> {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
	Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_PAGER: "" });
	try {
		const result = await exec(options.executable ?? "git", ["--no-pager", "--no-replace-objects", "-c", "core.fsmonitor=false", ...args], { cwd, env, encoding: "utf8", timeout: 10_000, maxBuffer: options.maxBuffer ?? 64 * 1024, signal: options.signal, windowsHide: true });
		return result.stdout;
	} catch (error) {
		if (options.signal?.aborted) throw new DOMException("Git read cancelled", "AbortError");
		throw new Error("Git 读取失败、超时或超过输出预算；请确认仓库/ref 可用，缩小提交范围");
	}
}
