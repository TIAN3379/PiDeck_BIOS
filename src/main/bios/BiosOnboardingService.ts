/** UX-03：可信项目预览与显式授权接入，复用配置失效和 core 绑定链。 */
import { randomUUID } from "node:crypto";
import { updateRegistry } from "../../../packages/bios-agent/core/storage/index.ts";
import type { BiosConnectionList, BiosDisconnectRequest, BiosDisconnectResult } from "../../shared/types/biosOnboarding";
import { realpath, stat } from "node:fs/promises";
import { readRegistry, resolveProjectBinding } from "../../../packages/bios-agent/core/storage/registry.ts";
import { requireFullyQualifiedRoot } from "../../../packages/bios-agent/core/paths.ts";
import { normalizeBiosHostSettings } from "./biosProcessEnv.ts";
import type { BiosEndpointGrant, BiosHostSettings, BiosRuntimeState } from "../../shared/types/bios";
import type { BiosBindRequest, BiosBusinessEnvelope, BindProjectResult } from "../../shared/types/biosBusiness";
import type { BiosOnboardingConfirm, BiosOnboardingPreview, BiosOnboardingResult, BiosServiceRef } from "../../shared/types/biosOnboarding";

/** D4：主进程核对出的**真实**模型服务身份（只含 provider/modelId/HTTP(S) 源）。 */
export type BiosResolvedService = { readonly provider: string; readonly modelId: string; readonly origin: string };

type AuthorizationReceipt = { readonly settings: BiosHostSettings; readonly runtime: BiosRuntimeState };
type Proposal = { preview: BiosOnboardingPreview; configKey: string; registryRevision: number | null; rootAction: "reuse" | "create-default"; serviceRef: BiosServiceRef | null };
export type BiosOnboardingOptions = {
	readSettings: () => Partial<BiosHostSettings> | null;
	readConfigurationVersion: () => number;
	resolveProject: (id: string) => { readonly name: string; readonly path: string; readonly kind?: string } | null;
	saveAuthorization: (patch: Partial<BiosHostSettings>) => Promise<AuthorizationReceipt>;
	bindProject: (request: BiosBindRequest) => Promise<BiosBusinessEnvelope<BindProjectResult>>;
	/**
	 * AW-01：未配置知识根时提议的**默认库**路径（主进程用 `app.getPath("userData")` 派生）。
	 * 不提供时保持旧行为（要求用户先显式选目录）。
	 */
	resolveDefaultKnowledgeRoot?: () => string;
	/** AW-01：在一次确认里初始化默认库（幂等；已存在时返回 existing）。 */
	initializeStore?: (request: { readonly knowledgeRoot: string }) => Promise<{ readonly ok: boolean; readonly problem: string | null }>;
	/**
	 * D4：按 renderer 提交的**会话引用**核对真实运行态，返回该会话当前实际使用的模型服务身份。
	 *
	 * 三条契约：
	 * - 只做**查找**，不采信 renderer 提交的 provider/model/地址；
	 * - sessionId/generation 必须与主进程持有的 runtime 一致，否则返回 null（拒绝把许可绑到别的 runtime）；
	 * - 读不到（模型未启动/字段缺失）返回 null —— 宁可**不授权**，也不绑一个核对不了的许可。
	 */
	resolveService?: (ref: BiosServiceRef) => Promise<BiosResolvedService | null>;
	now?: () => number;
};

const PREVIEW_TTL = 10 * 60_000;
const MAX_PREVIEWS = 64;

export class BiosOnboardingService {
	private readonly options: BiosOnboardingOptions;
	private readonly proposals = new Map<string, Proposal>();
	private queue: Promise<unknown> = Promise.resolve();
	constructor(options: BiosOnboardingOptions) {
		this.options = options;
	}
	private now(): number {
		return this.options.now?.() ?? Date.now();
	}
	private settings(): BiosHostSettings {
		return normalizeBiosHostSettings(this.options.readSettings());
	}
	private configKey(): string {
		return JSON.stringify([this.options.readConfigurationVersion(), this.settings()]);
	}
	private async project(id: string) {
		const project = this.options.resolveProject(id);
		if (id === "builtin-chat" || project?.kind === "chat") throw new Error("普通聊天不能接入 BIOS 工程，请选择真实项目");
		if (project === null) throw new Error("找不到当前桌面项目，请重新选择项目");
		const path = await realpath(requireFullyQualifiedRoot(project.path, "项目目录"));
		if (!(await stat(path)).isDirectory()) throw new Error("当前项目不是可用的源码目录");
		return { name: project.name, path };
	}

	/** Local human management, independent of a model/runtime grant. No knowledge bodies returned. */
	async connections(): Promise<BiosConnectionList> {
		const configurationVersion = this.options.readConfigurationVersion();
		const settings = this.settings();
		if (settings.knowledgeRoot === null) throw new Error("尚未配置知识库");
		const registry = await readRegistry({ root: settings.knowledgeRoot });
		if (configurationVersion !== this.options.readConfigurationVersion()) throw new Error("配置已变化，请刷新");
		return {
			configurationVersion,
			revision: registry.revision,
			projects: registry.projects.map((entry) => ({
				projectId: entry.biosProjectId,
				displayName: entry.displayName ?? entry.biosProjectId,
				...(entry.desktopProjectId === undefined ? {} : { desktopProjectId: entry.desktopProjectId }),
				paths: entry.workspaces.map((workspace) => workspace.path),
				authorized: settings.authorizedProjectIds.includes(entry.biosProjectId),
			})),
		};
	}

	disconnect(request: BiosDisconnectRequest): Promise<BiosDisconnectResult> {
		const next = this.queue.then(() => this.disconnectOnce(request));
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async disconnectOnce(request: BiosDisconnectRequest): Promise<BiosDisconnectResult> {
		if (request.confirmed !== true) throw new Error("请明确确认取消接入");
		const settings = this.settings();
		const root = settings.knowledgeRoot;
		if (root === null) throw new Error("尚未配置知识库");
		const registry = await readRegistry({ root });
		if (registry.revision !== request.expectedRevision || request.configurationVersion !== this.options.readConfigurationVersion()) throw new Error("项目列表或配置已变化，请刷新后确认");
		const target = registry.projects.find((entry) => entry.biosProjectId === request.projectId);
		if (target === undefined) throw new Error("项目不存在，请刷新");
		const targetPaths = new Set(target.workspaces.map((workspace) => workspace.path));
		const sharedPaths = new Set(registry.projects.filter((entry) => entry.biosProjectId !== request.projectId && settings.authorizedProjectIds.includes(entry.biosProjectId)).flatMap((entry) => entry.workspaces.map((workspace) => workspace.path)));
		// Revoke first: even a later CAS failure must not leave the old runtime authorized.
		const authorization = await this.options.saveAuthorization({ authorizedProjectIds: settings.authorizedProjectIds.filter((id) => id !== request.projectId), authorizedRoots: settings.authorizedRoots.filter((path) => !targetPaths.has(path) || sharedPaths.has(path)) });
		this.proposals.clear();
		try {
			if (this.settings().knowledgeRoot !== root) throw new Error("知识库配置已变化");
			if (target.desktopProjectId !== undefined) {
				const projects = registry.projects.map((entry) => {
					if (entry.biosProjectId !== request.projectId) return entry;
					const { desktopProjectId: _desktop, ...retained } = entry;
					return { ...retained, updatedAt: this.now() };
				});
				const written = await updateRegistry({ root, projects, expectedRevision: registry.revision, now: this.now() });
				if (written.warnings?.length) throw new Error(written.warnings.join("；"));
			}
			return { status: "completed", problem: null, runtime: authorization.runtime };
		} catch (error) {
			return { status: "partial", problem: `权限已撤销，绑定解除需核对：${error instanceof Error ? error.message : String(error)}`, runtime: authorization.runtime };
		}
	}

	/**
	 * 只读预览：不授权、不创建目录/档案，UUID 是一次性提议而非事实。
	 *
	 * AW-01：未配置知识根时**提议默认库**（主进程 userData 下），一次确认即可建库 + 绑定；
	 * 已有知识根（含用户既有 `D:\BIOS_Knowledge`）一律复用，不迁移、不另建空库。
	 */
	async prepare(desktopProjectId: string, serviceRef?: BiosServiceRef): Promise<BiosOnboardingPreview> {
		const configKey = this.configKey();
		const configured = this.settings().knowledgeRoot;
		const rootAction: "reuse" | "create-default" = configured === null ? "create-default" : "reuse";
		const root = configured ?? this.options.resolveDefaultKnowledgeRoot?.() ?? null;
		if (root === null) throw new Error("请先选择并创建知识库，再接入项目");
		const project = await this.project(desktopProjectId);
		// 默认库尚未创建时 registry 不存在：这里容忍缺失，真正的创建发生在确认之后。
		let registry: Awaited<ReturnType<typeof readRegistry>> | null = null;
		if (rootAction === "reuse") {
			registry = await readRegistry({ root });
		} else {
			try {
				registry = await readRegistry({ root });
			} catch {
				registry = null;
			}
		}
		if (registry !== null) {
			const binding = resolveProjectBinding(registry, { workspacePath: project.path });
			const byDesktop = registry.projects.find((entry) => entry.desktopProjectId === desktopProjectId);
			if (binding.status === "conflict" || (binding.status === "resolved" && binding.project.desktopProjectId !== undefined && binding.project.desktopProjectId !== desktopProjectId) || (byDesktop !== undefined && (binding.status !== "resolved" || byDesktop.biosProjectId !== binding.project.biosProjectId))) {
				throw new Error("当前目录的绑定存在冲突或发生迁移。请打开 BIOS 右栏的「管理接入 / 处理绑定冲突」，核对旧项目名称和路径，取消旧关联后重新预览；历史知识保留，不自动合并。");
			}
		}
		const service = serviceRef === undefined ? null : ((await this.options.resolveService?.(serviceRef)) ?? null);
		if (configKey !== this.configKey()) throw new Error("配置已变化，请重新预览");
		const resolved = registry === null ? null : resolveProjectBinding(registry, { workspacePath: project.path });
		const now = this.now();
		for (const [key, proposal] of this.proposals) if (proposal.preview.expiresAt <= now) this.proposals.delete(key);
		if (this.proposals.size >= MAX_PREVIEWS) this.proposals.delete(this.proposals.keys().next().value ?? "");
		const preview: BiosOnboardingPreview = {
			token: randomUUID(),
			desktopProjectId,
			biosProjectId: resolved !== null && resolved.status === "resolved" ? resolved.project.biosProjectId : randomUUID(),
			displayName: resolved !== null && resolved.status === "resolved" ? (resolved.project.displayName ?? resolved.project.biosProjectId.slice(0, 8)) : project.name.slice(0, 120),
			workspacePath: project.path,
			knowledgeRoot: root,
			existing: resolved !== null && resolved.status === "resolved",
			// Legacy path-only records still need explicit desktop binding. Otherwise the
			// sidebar offers onboarding while the root dialog silently hides as service-only.
			authorized: resolved !== null && resolved.status === "resolved" && resolved.project.desktopProjectId === desktopProjectId && this.settings().authorizedProjectIds.includes(resolved.project.biosProjectId) && this.settings().authorizedRoots.includes(project.path),
			rootAction,
			// D4：卡上必须显示**当前真实策略**（unknown 就显示 unknown，不给"顺手放行"的捷径）。
			endpoint: this.settings().endpoint,
			// D4：已绑定的具名许可原样显示（没有则为 null）——卡上据此说明"当前许可发给谁"。
			endpointGrant: this.settings().endpointGrant ?? null,
			service,
			expiresAt: now + PREVIEW_TTL,
		};
		this.proposals.set(preview.token, { preview, configKey, registryRevision: registry?.revision ?? null, rootAction, serviceRef: serviceRef === undefined ? null : { ...serviceRef } });
		return preview;
	}

	/** 串行确认，避免两个预览同时扩大许可并创建重复档案。 */
	complete(request: BiosOnboardingConfirm): Promise<BiosOnboardingResult> {
		const next = this.queue.then(() => this.completeOnce(request));
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async completeOnce(request: BiosOnboardingConfirm): Promise<BiosOnboardingResult> {
		if (request.confirmed !== true) throw new Error("必须由用户明确确认项目和目录授权");
		const proposal = this.proposals.get(request.token);
		if (proposal === undefined || proposal.preview.expiresAt <= this.now()) throw new Error("接入预览已失效，请重新预览");
		const { preview } = proposal;
		if (request.serviceOnly === true && (!preview.existing || preview.authorized !== true || !this.settings().authorizedProjectIds.includes(preview.biosProjectId) || !this.settings().authorizedRoots.includes(preview.workspacePath) || request.endpointConsent !== true || request.automation !== undefined))
			throw new Error("模型服务确认只适用于已授权项目，不扩大项目、目录或自动化权限");
		const displayName = request.displayName?.trim() || preview.displayName;
		if (displayName.length > 120) throw new Error("项目名称不能超过 120 个字符");
		if (preview.existing && displayName !== preview.displayName) throw new Error("接入入口只复用已有档案，不重命名现有项目");
		const project = await this.project(preview.desktopProjectId);
		const currentRevision = await (async (): Promise<number | null> => {
			try {
				return (await readRegistry({ root: preview.knowledgeRoot })).revision;
			} catch {
				return null;
			}
		})();
		if (proposal.configKey !== this.configKey() || project.path !== preview.workspacePath || currentRevision !== proposal.registryRevision) {
			this.proposals.delete(request.token);
			throw new Error("配置、项目目录或绑定已变化，请重新预览后确认");
		}
		// D4：勾选端点外发时**先核对真实运行态**——核对不了就整批失败，绝不凭 renderer 的字段绑定。
		// 版本号只增不减：重新确认即新许可，旧代次 runtime 按指纹失效（不会被新许可"复活"）。
		let endpointGrantPatch: Partial<BiosHostSettings> = {};
		if (request.endpointConsent === true) {
			if (this.options.resolveService === undefined) throw new Error("主进程未接入真实模型端点核对能力：无法绑定具名外发许可，请在设置里显式配置端点策略");
			if (request.serviceRef === undefined) throw new Error("缺少可核对的会话引用：请在有运行会话（模型已启动）时勾选外发授权");
			const service = await this.options.resolveService(request.serviceRef);
			if (service === null) throw new Error("无法核对当前实际模型端点（会话已结束、代次不匹配或模型信息不可用）：本次不授权外发，请在运行会话里重新确认");
			if (preview.service == null || proposal.serviceRef === null || JSON.stringify(proposal.serviceRef) !== JSON.stringify(request.serviceRef) || service.provider !== preview.service.provider || service.modelId !== preview.service.modelId || service.origin !== preview.service.origin)
				throw new Error("模型服务已变化或未预览，请重新预览实际模型后确认");
			if (proposal.configKey !== this.configKey()) throw new Error("配置已变化，请重新预览");
			const grant: BiosEndpointGrant = { provider: service.provider, modelId: service.modelId, origin: service.origin, version: (this.settings().endpointGrant?.version ?? 0) + 1 };
			endpointGrantPatch = { endpoint: "allowed", endpointGrant: grant };
		}
		// 从可信快照派生最小授权；不接受 renderer 的 root、UUID、目录或外发许可。
		this.proposals.delete(request.token);
		let authorization: AuthorizationReceipt | null = null;
		try {
			if (request.serviceOnly === true) {
				authorization = await this.options.saveAuthorization(endpointGrantPatch);
				return { status: "completed", preview, authorization, binding: null, problem: null };
			}
			// AW-01：未配置知识根时，一次确认同时完成"写知识根 + 建默认库 + 授权 + 绑定"。
			if (proposal.rootAction === "create-default") {
				if (this.options.initializeStore === undefined) throw new Error("主进程未提供默认库创建能力，请先在设置里选择并创建知识库");
				// Saving the root intentionally stops old runtimes. Persist the already-reviewed service grant
				// in that same save; querying the stopped runtime later would reject our own successful revocation.
				authorization = await this.options.saveAuthorization({ knowledgeRoot: preview.knowledgeRoot, ...endpointGrantPatch });
				endpointGrantPatch = {};
				const initializedConfig = this.configKey();
				const initialized = await this.options.initializeStore({ knowledgeRoot: preview.knowledgeRoot });
				if (!initialized.ok) throw new Error(initialized.problem ?? "默认知识库创建失败");
				if (initializedConfig !== this.configKey()) throw new Error("建库期间配置已变化，请重新预览后确认");
			}
			// AW-01：一次确认里同时落自动化许可（缺省不授予，保持旧行为）。
			// 只开普通记账/资料注入；版本号递增，使已运行会话的旧许可按指纹失效。
			const automationPatch =
				request.automation === undefined
					? {}
					: {
							automation: {
								enabled: true,
								localBookkeeping: request.automation.localBookkeeping === true,
								injectProjectData: request.automation.injectProjectData === true,
								version: this.settings().automation.version + 1,
							},
						};
			// Default-store creation may await IO; never authorize a service different from the displayed snapshot.
			if (proposal.rootAction !== "create-default" && request.endpointConsent === true && request.serviceRef !== undefined) {
				const latest = await this.options.resolveService?.(request.serviceRef);
				if (latest == null || latest.provider !== preview.service?.provider || latest.modelId !== preview.service.modelId || latest.origin !== preview.service.origin) throw new Error("模型服务已变化，请重新预览后确认");
			}
			authorization = await this.options.saveAuthorization({
				authorizedProjectIds: [...new Set([...this.settings().authorizedProjectIds, preview.biosProjectId])],
				authorizedRoots: [...new Set([...this.settings().authorizedRoots, project.path])],
				...automationPatch,
				// D4：端点授权**只在用户明确勾选且核对通过**时写入；未勾选保持当前策略
				//     （unknown 不会被顺手改掉），勾选但核对失败的情形在上面已整批拒绝。
				...endpointGrantPatch,
			});
			// 保存后复查根和真实目录；外部变更不能把绑定写到另一库/另一目录。
			if (this.settings().knowledgeRoot !== preview.knowledgeRoot || (await this.project(preview.desktopProjectId)).path !== project.path) throw new Error("授权保存后配置或目录变化，请重新预览");
			const binding = await this.options.bindProject({ desktopProjectId: preview.desktopProjectId, biosProjectId: preview.biosProjectId, displayName });
			const completed = binding.guard.stable && (binding.result.status === "bound" || binding.result.status === "already-bound");
			return { status: completed ? "completed" : "partial", preview, authorization, binding, problem: completed ? null : (binding.guard.staleReason ?? binding.result.problems.join("；")) };
		} catch (error) {
			return { status: "partial", preview, authorization, binding: null, problem: error instanceof Error ? error.message : String(error) };
		}
	}
}
