import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { readHistoryGit } from "../../../packages/bios-agent/core/projects/historyGit.ts";
import { readRegistry, resolveProjectBinding } from "../../../packages/bios-agent/core/storage/registry.ts";
import { isWithinAuthorizedRoot } from "../../../packages/bios-agent/core/projects/authorization.ts";
import { requireFullyQualifiedRoot } from "../../../packages/bios-agent/core/paths.ts";
import { currentGitExecutable } from "../git/gitExecutable.ts";
import { normalizeBiosHostSettings } from "./biosProcessEnv.ts";
import type { BiosHostSettings } from "../../shared/types/bios";
import type { BiosHistoryCommit, BiosHistoryEvidence, BiosHistoryPreview, BiosHistoryRequest } from "../../shared/types/biosHistory";

type Options = { readSettings: () => Partial<BiosHostSettings> | null; readConfigurationVersion: () => number; resolveProject: (id: string) => { path: string } | null; now?: () => number };
type Snapshot = { path: string; key: string; revision: number };
type Cached = { preview: BiosHistoryPreview; snapshot: Snapshot };

/** 禁用外部差异驱动/替换对象，并清理继承 Git 环境，防止读到另一仓库或隐式联网。 */
export async function runHistoryGit(cwd: string, args: string[], maxBuffer = 256 * 1024): Promise<string> {
	return readHistoryGit(cwd, args, { executable: currentGitExecutable(), maxBuffer });
}

export function validateHistoryRequest(request: BiosHistoryRequest): void {
	for (const id of [request.desktopProjectId, request.projectId]) if (typeof id !== "string" || !id.trim() || id.length > 256) throw new Error("项目 ID 无效");
	if (typeof request.ref !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_./-]{0,127}$/.test(request.ref) || request.ref.includes("..")) throw new Error("ref 必须是单个分支/tag/提交，不接受范围或 Git 参数");
	if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100) throw new Error("提交上限必须是 1～100");
	if (typeof request.keyword !== "string" || request.keyword.length > 128) throw new Error("关键词超过上限");
}

export class BiosHistoryService {
	private readonly options: Options;
	private readonly previews = new Map<string, Cached>();
	private reading = false;
	constructor(options: Options) {
		this.options = options;
	}
	private now(): number {
		return this.options.now?.() ?? Date.now();
	}
	private settings(): BiosHostSettings {
		return normalizeBiosHostSettings(this.options.readSettings());
	}
	private async snapshot(desktopProjectId: string, projectId: string): Promise<Snapshot> {
		const settings = this.settings();
		const key = JSON.stringify([this.options.readConfigurationVersion(), settings]);
		if (settings.knowledgeRoot === null || !settings.authorizedProjectIds.includes(projectId)) throw new Error("历史项目未接入或未授权");
		const desktop = this.options.resolveProject(desktopProjectId);
		if (desktop === null) throw new Error("找不到当前桌面项目");
		const path = await realpath(requireFullyQualifiedRoot(desktop.path, "项目目录"));
		let authorized = false;
		for (const root of settings.authorizedRoots) {
			try {
				if (isWithinAuthorizedRoot(await realpath(requireFullyQualifiedRoot(root, "授权目录")), path)) authorized = true;
			} catch {
				/* 离线/非法根不授予访问。 */
			}
		}
		if (!authorized) throw new Error("项目目录不在明确授权范围内");
		const registry = await readRegistry({ root: settings.knowledgeRoot });
		const binding = resolveProjectBinding(registry, { workspacePath: path, biosProjectId: projectId, desktopProjectId });
		if (binding.status !== "resolved") throw new Error("项目登记与当前桌面目录不一致，请重新核对接入");
		// 子目录打开的项目不能悄悄扫描父仓库的其它板卡/客户。
		const repo = await realpath((await runHistoryGit(path, ["rev-parse", "--show-toplevel"], 4096)).trim());
		if (repo !== path) throw new Error("当前项目不是 Git 仓库根目录；请单独接入并授权仓库根");
		if (key !== JSON.stringify([this.options.readConfigurationVersion(), this.settings()])) throw new Error("配置已变化，请重新读取");
		return { path, key, revision: registry.revision };
	}
	private async head(path: string, ref: string): Promise<string> {
		const sha = (await runHistoryGit(path, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], 4096)).trim();
		if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error("无法确定提交身份");
		return sha;
	}
	private async read<T>(action: () => Promise<T>): Promise<T> {
		if (this.reading) throw new Error("历史读取正在进行，请稍后重试");
		this.reading = true;
		try {
			return await action();
		} finally {
			this.reading = false;
		}
	}
	scan(request: BiosHistoryRequest): Promise<BiosHistoryPreview> {
		return this.read(() => this.scanOnce(request));
	}
	private async scanOnce(request: BiosHistoryRequest): Promise<BiosHistoryPreview> {
		validateHistoryRequest(request);
		const before = await this.snapshot(request.desktopProjectId, request.projectId);
		const head = await this.head(before.path, request.ref);
		const output = await runHistoryGit(before.path, ["log", `-n${request.limit + 1}`, "--format=%H%x00%P%x00%cI%x00%s%x00%B%x00%x1e", head, "--"]);
		const all: BiosHistoryCommit[] = output
			.split("\x1e")
			.filter((entry) => entry.trim())
			.map((entry) => {
				const fields = entry.trimStart().split("\0");
				const [sha, parents, date, subject, message, end] = fields;
				if (fields.length !== 6 || end !== "" || !/^[a-f0-9]{40,64}$/.test(sha) || !/^\d{4}-\d{2}-\d{2}T/.test(date) || subject === undefined || message === undefined || message.length > 16_000) throw new Error("提交元数据无效或超限");
				const parentIds = parents === "" ? [] : parents.split(" ");
				if (parentIds.some((id) => !/^[a-f0-9]{40,64}$/.test(id))) throw new Error("父提交身份无效");
				return { sha, parents: parentIds, date, subject, message };
			});
		const after = await this.snapshot(request.desktopProjectId, request.projectId);
		if (JSON.stringify(before) !== JSON.stringify(after) || head !== (await this.head(after.path, request.ref))) throw new Error("配置、登记或分支发生变化，请重新扫描");
		const window = all.slice(0, request.limit);
		const keyword = request.keyword.trim().toLowerCase();
		const preview: BiosHistoryPreview = {
			token: randomUUID(),
			projectId: request.projectId,
			desktopProjectId: request.desktopProjectId,
			workspacePath: before.path,
			ref: request.ref,
			head,
			commits: window.filter((entry) => !keyword || entry.message.toLowerCase().includes(keyword)),
			scanned: window.length,
			hasMore: all.length > request.limit,
			expiresAt: this.now() + 10 * 60_000,
		};
		for (const [token, cached] of this.previews) if (cached.preview.expiresAt <= this.now()) this.previews.delete(token);
		if (this.previews.size >= 32) this.previews.delete(this.previews.keys().next().value ?? "");
		this.previews.set(preview.token, { preview, snapshot: before });
		return preview;
	}
	evidence(token: string, sha: string): Promise<BiosHistoryEvidence> {
		return this.read(() => this.evidenceOnce(token, sha));
	}
	private async evidenceOnce(token: string, sha: string): Promise<BiosHistoryEvidence> {
		const cached = this.previews.get(token);
		if (!cached || cached.preview.expiresAt <= this.now()) throw new Error("历史预览已过期，请重新扫描");
		const { preview, snapshot } = cached;
		const commit = preview.commits.find((entry) => entry.sha === sha);
		if (!commit) throw new Error("该提交不在本次候选范围内");
		const before = await this.snapshot(preview.desktopProjectId, preview.projectId);
		if (JSON.stringify(before) !== JSON.stringify(snapshot) || preview.head !== (await this.head(before.path, preview.ref))) throw new Error("历史预览的配置、登记或分支已变化");
		// 合并提交明确按第一父比较；根提交使用 show，不伪称已查后续所有撤销。
		const args = commit.parents.length ? ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--unified=3", commit.parents[0], commit.sha, "--"] : ["show", "--format=", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", commit.sha, "--"];
		const diff = await runHistoryGit(before.path, args, 64 * 1024);
		const after = await this.snapshot(preview.desktopProjectId, preview.projectId);
		if (JSON.stringify(after) !== JSON.stringify(before) || preview.head !== (await this.head(after.path, preview.ref))) throw new Error("读取期间授权/项目/分支变化，结果作废");
		return { token, projectId: preview.projectId, desktopProjectId: preview.desktopProjectId, commit, diff, maySendToModel: this.settings().endpoint === "allowed" };
	}
}
