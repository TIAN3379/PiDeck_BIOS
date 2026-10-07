/** 项目接入是本地人工管理能力，不向模型暴露授权/写入工具。 */
import type { BiosBusinessEnvelope, BindProjectResult } from "./biosBusiness";
import type { BiosEndpointGrant, BiosEndpointPolicy, BiosHostSettings, BiosRuntimeState } from "./bios";

export type BiosConnectionList = {
	readonly configurationVersion: number;
	readonly revision: number;
	readonly projects: readonly { readonly projectId: string; readonly displayName: string; readonly desktopProjectId?: string; readonly paths: readonly string[]; readonly authorized: boolean }[];
};
export type BiosDisconnectRequest = { readonly projectId: string; readonly expectedRevision: number; readonly configurationVersion: number; readonly confirmed: boolean };
export type BiosDisconnectResult = { readonly status: "completed" | "partial"; readonly problem: string | null; readonly runtime: BiosRuntimeState };

export type BiosOnboardingPreview = {
	readonly token: string;
	readonly desktopProjectId: string;
	readonly biosProjectId: string;
	readonly displayName: string;
	readonly workspacePath: string;
	readonly knowledgeRoot: string;
	readonly existing: boolean;
	/** Fully connected: exact desktop binding plus project and directory grants. Legacy path-only records still require binding confirmation. */
	readonly authorized?: boolean;
	/**
	 * AW-01：`reuse` = 复用已配置的知识根（含用户现有 `D:\BIOS_Knowledge`）；
	 * `create-default` = 尚未配置，本次确认会创建主进程 userData 下的默认库。
	 */
	readonly rootAction: "reuse" | "create-default";
	/**
	 * D4：**当前**端点外发策略（可信配置里的真实值；卡上必须如实显示，不能静默改成 allowed）。
	 *
	 * `unknown`/`denied` 时普通开发照常，但 BIOS 知识检索/注入不可用——卡上要说清楚。
	 */
	readonly endpoint: BiosEndpointPolicy;
	/**
	 * D4：**已绑定**的具名端点许可（没有则为 null）。
	 *
	 * 卡上据此显示"当前许可是发给哪个 provider/model/地址"，并与实际模型事实比对；
	 * 不一致时说明"这是旧许可，资料不会外发"。
	 */
	readonly endpointGrant: BiosEndpointGrant | null;
	/** Trusted runtime snapshot shown by the preview; confirmation must still match it. */
	readonly service?: { readonly provider: string; readonly modelId: string; readonly origin: string } | null;
	readonly expiresAt: number;
};

/**
 * D4：**服务引用**——renderer 只能提交"哪一栏会话"，主进程再按它核对真实运行态。
 *
 * 三个字段都必须与主进程持有的 runtime 一致；不一致即视为无法核对，**不落具名许可**
 * （renderer 不能直接提交 provider/model/地址，那些事实只能由主进程从运行态读）。
 */
export type BiosServiceRef = {
	readonly agentId: string;
	readonly sessionId: string | null;
	readonly generation: number;
};

export type BiosOnboardingConfirm = {
	/** Existing authorized project: change only the service grant, never bind/expand other permissions. */
	readonly serviceOnly?: boolean;
	readonly token: string;
	readonly confirmed: boolean;
	readonly displayName?: string;
	/**
	 * AW-01：**一次合并授权**里的自动化许可（缺省 = 不授予，保持旧行为）。
	 *
	 * 主确认按钮勾选后，本次确认同时完成"写知识根 + 建默认库 + 授权 + 绑定 + 开启受限普通记账"。
	 * 只授予普通记账与资料注入，不授予审核/验证/授权扩大/关键状态变更。
	 */
	readonly automation?: {
		readonly localBookkeeping: boolean;
		readonly injectProjectData: boolean;
	};
	/**
	 * D4：**端点外发的显式授权**（缺省 = 不改动，保持当前策略）。
	 *
	 * 只有在用户明确勾选时才会把 `endpoint` 写成 `allowed`；未勾选一律保持原值
	 * （`unknown` 不会被"确认接入"顺手改成允许外发）。它只是授权，不承诺任何网络连通性。
	 *
	 * 勾选时还必须同时给出可核对的 `serviceRef`：主进程据此读取**真实运行态**并把
	 * provider/model/API 源写进具名许可（渲染层提交的 provider/model 一律不采信）。
	 */
	readonly endpointConsent?: boolean;
	/** D4：勾选端点外发时，用来核对真实模型服务的会话引用。 */
	readonly serviceRef?: BiosServiceRef;
};

/** 授权已保存但绑定失败时不会自动撤销，必须如实说明分步结果。 */
export type BiosOnboardingResult = {
	readonly status: "completed" | "partial";
	readonly preview: BiosOnboardingPreview;
	readonly authorization: { readonly settings: BiosHostSettings; readonly runtime: BiosRuntimeState } | null;
	readonly binding: BiosBusinessEnvelope<BindProjectResult> | null;
	readonly problem: string | null;
};
