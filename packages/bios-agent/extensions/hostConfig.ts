/**
 * BM-06 B1：**可信宿主配置**（模型无法扩权）。
 *
 * 知识根、被授权项目、批准客户、端点策略只能来自**人工配置/可信适配层**（环境变量或桌面注入），
 * 绝不接受模型通过工具参数传入——否则"读取范围"就变成提示词可以改变的东西。
 *
 * 缺省即拒绝：`BIOS_AUTHORIZED_PROJECTS` 为空时，知识类工具不读取任何记录（返回可用缺口），
 * 而不是退回"读全部"。
 */
import { resolveKnowledgeRoot } from "../core/paths.ts";
import { AUTOMATION_DISABLED, type AutomationCapability } from "../core/automation/contract.ts";
import { type EndpointGrant, type EndpointServiceIdentity } from "../core/context/policy.ts";
import { parseEndpointGrant } from "../core/context/serviceIdentity.ts";

/**
 * 端点策略：`allowed` 允许外发商业正文；`denied` 拒绝；`unknown`（默认）不自动注入正文。
 *
 * D4：`grant` 是宿主绑定的**具名许可**（provider/model/API 源 + 版本）；`actual` 是**当前实际**
 * 模型服务身份（由调用上下文从 Pi 模型快照派生）。两者都在时，`outboundPolicy` 会在发送前核对；
 * `actual` 只在这里由 trusted 上下文覆写，模型参数改不了它。
 */
export type BiosEndpointPolicy = {
	readonly endpointAllowed: boolean | null;
	readonly allowInternalGeneral: boolean;
	readonly customers: readonly string[];
	readonly grant: EndpointGrant | null;
	readonly actual: EndpointServiceIdentity | null;
};

export type BiosHostConfig = {
	/** 解析到的知识根；未配置时为 `null`（工具返回缺口，不猜目录）。 */
	readonly knowledgeRoot: string | null;
	readonly knowledgeRootSource: string;
	/** 被授权项目（显式列出；空 = 没有授权任何项目）。 */
	readonly authorizedProjectIds: readonly string[];
	/** 显式授权的需求 ID（需求没有项目归属，只能按 ID 或批准客户授权）。 */
	readonly allowedFeatureIds: readonly string[];
	/** 明确批准的客户范围。 */
	readonly approvedCustomers: readonly string[];
	readonly endpoint: BiosEndpointPolicy;
	/**
	 * AW-00：**宿主自动化许可**（缺省全关，等价于 0.9.1 行为）。
	 *
	 * 它是持久宿主事实，不是模型结论：扩展只读，模型参数改不了它。
	 */
	readonly automation: AutomationCapability;
};

export const BIOS_CONFIG_ENV = {
	/** 允许被读取/引用的项目（逗号/分号/空白分隔的 UUID）。 */
	authorizedProjects: "BIOS_AUTHORIZED_PROJECTS",
	/** 显式授权的需求 ID。 */
	allowedFeatureIds: "BIOS_ALLOWED_FEATURE_IDS",
	/** 明确批准的客户范围。 */
	approvedCustomers: "BIOS_APPROVED_CUSTOMERS",
	/** `allowed` | `denied` | `unknown`（缺省 unknown）。 */
	endpoint: "BIOS_ENDPOINT",
	/** D4：具名端点许可 JSON（`{provider, modelId, origin, version}`）；空串 = 未绑定。 */
	endpointGrant: "BIOS_ENDPOINT_GRANT",
	/** 是否放行 internal-general 复用（`1`/`true`）。 */
	allowInternalGeneral: "BIOS_ALLOW_INTERNAL_GENERAL",
	/**
	 * 适配层注入的**初始选择**（R31-2 / C3）：项目 / 任务 / 工作区 ID 与是否打开上下文。
	 *
	 * 与 `BIOS_AUTHORIZED_PROJECTS` 同属可信通道；**不是**"已生效"的许可——
	 * 扩展会在使用前用真实服务复验（任务存在、工作区属于该任务、项目在授权集合内），
	 * 复验失败即视为未选择并给出原因。
	 */
	selectedProject: "BIOS_SELECTED_PROJECT_ID",
	selectedTask: "BIOS_SELECTED_TASK_ID",
	selectedWorkspace: "BIOS_SELECTED_WORKSPACE_ID",
	contextEnabled: "BIOS_CONTEXT_ENABLED",
	/** AW-00：自动化总开关（`1`/`true`）。缺省 = 关闭（与 0.9.1 等价）。 */
	automationEnabled: "BIOS_AUTOMATION_ENABLED",
	/** AW-00：允许本地普通记账（任务进度/检查点/本项目草稿）。 */
	automationBookkeeping: "BIOS_AUTOMATION_BOOKKEEPING",
	/** AW-00：允许把本项目资料注入当前模型请求。 */
	automationInject: "BIOS_AUTOMATION_INJECT",
	/** AW-00：宿主许可版本；变化即要求重新复验。 */
	automationVersion: "BIOS_AUTOMATION_VERSION",
} as const;

/** 开关解析：只有显式 `1/true/yes` 才算开启（缺省即关闭）。 */
function readSwitch(raw: string | undefined): boolean {
	return /^(1|true|yes)$/i.test((raw ?? "").trim());
}

/**
 * 读取宿主自动化许可。
 *
 * 版本语义：开启但版本缺失/非法时按 **1**（首个许可版本）处理——总开关才是授权依据；
 * 关闭时一律回 `AUTOMATION_DISABLED`（版本 0 = 未授予），避免"关了开关还留着许可版本"。
 */
export function readAutomationCapability(env: NodeJS.ProcessEnv = process.env): AutomationCapability {
	const enabled = readSwitch(env[BIOS_CONFIG_ENV.automationEnabled]);
	if (!enabled) return AUTOMATION_DISABLED;
	const parsed = Number.parseInt((env[BIOS_CONFIG_ENV.automationVersion] ?? "").trim(), 10);
	return {
		enabled: true,
		localBookkeeping: readSwitch(env[BIOS_CONFIG_ENV.automationBookkeeping]),
		injectProjectData: readSwitch(env[BIOS_CONFIG_ENV.automationInject]),
		version: Number.isFinite(parsed) && parsed > 0 ? parsed : 1,
	};
}

/** 只读取"选择相关"的初始值（其余配置由 `readBiosHostConfig` 读）。 */
export function readInitialSelection(env: NodeJS.ProcessEnv = process.env): { readonly projectId: string | null; readonly taskId: string | null; readonly workspaceId: string | null; readonly contextEnabled: boolean } {
	const taskId = (env[BIOS_CONFIG_ENV.selectedTask] ?? "").trim();
	return {
		projectId: (env[BIOS_CONFIG_ENV.selectedProject] ?? "").trim() === "" ? null : (env[BIOS_CONFIG_ENV.selectedProject] ?? "").trim(),
		taskId: taskId === "" ? null : taskId,
		workspaceId: (env[BIOS_CONFIG_ENV.selectedWorkspace] ?? "").trim() === "" ? null : (env[BIOS_CONFIG_ENV.selectedWorkspace] ?? "").trim(),
		contextEnabled: /^(1|true|yes)$/i.test((env[BIOS_CONFIG_ENV.contextEnabled] ?? "").trim()),
	};
}

function splitList(raw: string | undefined): string[] {
	if (raw === undefined) return [];
	return raw
		.split(/[,;\s]+/)
		.map((value) => value.trim())
		.filter((value) => value !== "");
}

function readEndpoint(env: NodeJS.ProcessEnv): boolean | null {
	const raw = (env[BIOS_CONFIG_ENV.endpoint] ?? "").trim().toLowerCase();
	if (raw === "allowed") return true;
	if (raw === "denied") return false;
	return null;
}

export function readBiosHostConfig(env: NodeJS.ProcessEnv = process.env): BiosHostConfig {
	let knowledgeRoot: string | null = null;
	let knowledgeRootSource = "none";
	try {
		const resolved = resolveKnowledgeRoot({ env });
		// 只有显式配置（override/env）才认为"已配置"；默认用户目录会让工具在没有配置时静默读错库。
		if (resolved.source !== "default") {
			knowledgeRoot = resolved.root;
			knowledgeRootSource = resolved.source;
		}
	} catch {
		knowledgeRoot = null;
		knowledgeRootSource = "invalid";
	}
	const customers = splitList(env[BIOS_CONFIG_ENV.approvedCustomers]);
	return {
		knowledgeRoot,
		knowledgeRootSource,
		authorizedProjectIds: splitList(env[BIOS_CONFIG_ENV.authorizedProjects]),
		allowedFeatureIds: splitList(env[BIOS_CONFIG_ENV.allowedFeatureIds]),
		approvedCustomers: customers,
		endpoint: {
			endpointAllowed: readEndpoint(env),
			allowInternalGeneral: /^(1|true|yes)$/i.test((env[BIOS_CONFIG_ENV.allowInternalGeneral] ?? "").trim()),
			customers,
			// D4：具名许可来自宿主注入（模型改不了）；实际服务身份在这里**无从得知**
			// （它只能来自 Pi 调用上下文），由 `buildCallContext` 覆写，默认 null = 保守。
			grant: parseEndpointGrant(env[BIOS_CONFIG_ENV.endpointGrant]),
			actual: null,
		},
		automation: readAutomationCapability(env),
	};
}

/**
 * D4：把**当前实际**模型服务身份并进可信配置（纯函数；`actual` 只能来自 Pi 调用上下文）。
 *
 * 为什么要在这里覆写而不是读 env：实际使用的模型可能在会话中途被切换，env 是进程启动快照。
 * 只有 Pi 报告的当前模型才是最权威的"资料会发给谁"。
 */
export function withActualService(config: BiosHostConfig, actual: EndpointServiceIdentity | null): BiosHostConfig {
	if (config.endpoint.actual === actual) return config;
	if (actual === null && config.endpoint.actual === null) return config;
	return { ...config, endpoint: { ...config.endpoint, actual } };
}

/** 知识类工具的统一前置判定：未配置知识根或没有任何项目授权 ⇒ 不读取任何记录。 */
export function hostReadiness(config: BiosHostConfig): { readonly ready: boolean; readonly reason: string | null } {
	if (config.knowledgeRoot === null) return { ready: false, reason: "宿主未配置知识根（BIOS_KNOWLEDGE_ROOT / 桌面设置）：拒绝读取知识库" };
	if (config.authorizedProjectIds.length === 0 && config.allowedFeatureIds.length === 0 && config.approvedCustomers.length === 0) {
		return { ready: false, reason: "宿主未授权任何项目/需求/客户：拒绝读取知识内容" };
	}
	return { ready: true, reason: null };
}

/**
 * 可信配置**指纹**（R31-2）：知识根、授权集合、端点策略与目录授权根任一变化都会改变它。
 *
 * 用途：上下文组装前后比对，发现"组装期间策略/授权/根已变"时丢弃旧结果——
 * 只比对选择代次无法发现这类变化。
 */
export function configFingerprint(config: BiosHostConfig, env: NodeJS.ProcessEnv = process.env): string {
	const grant = config.endpoint.grant;
	const actual = config.endpoint.actual;
	return [
		config.knowledgeRoot ?? "none",
		[...config.authorizedProjectIds].sort().join(","),
		[...config.allowedFeatureIds].sort().join(","),
		[...config.approvedCustomers].sort().join(","),
		config.endpoint.endpointAllowed === null ? "unknown" : config.endpoint.endpointAllowed ? "allowed" : "denied",
		config.endpoint.allowInternalGeneral ? "ig-on" : "ig-off",
		// D4：具名许可与**当前实际服务**都进指纹 ⇒ 换模型/改地址/重新确认后旧准备快照自动失效。
		grant === null ? "grant:none" : `grant:${grant.provider}/${grant.modelId}@${grant.origin}#${grant.version}`,
		actual === null ? "svc:none" : `svc:${actual.provider}/${actual.modelId}@${actual.origin}`,
		// AW：许可变化（总开关/记账/注入/版本）必须改变指纹 ⇒ 会话级许可与缓存自动失效。
		`aw:${config.automation.enabled ? 1 : 0}${config.automation.localBookkeeping ? 1 : 0}${config.automation.injectProjectData ? 1 : 0}@${config.automation.version}`,
		(env.BIOS_AUTHORIZED_ROOTS ?? "").trim(),
	].join("|");
}
