/**
 * D4：**当前实际模型端点事实**（只读展示用）。
 *
 * 为什么需要：首次接入卡原来只显示配置里的**策略枚举**（unknown/allowed/denied），
 * 用户看不到"资料到底会发给哪个模型"。这里从当前会话的 runtime 快照取真实 provider / 模型 id，
 * 让"是否允许外发"这个决定建立在可见事实上。
 *
 * 边界：
 * - 只读渲染层已有的 runtime 快照（不新增 IPC、不读密钥、不显示 API Key）；
 * - 没有运行中的会话时返回 null 字段，界面必须如实显示"读不到"，不能拿策略枚举冒充实际模型。
 */
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { currentSessionIdAtom, sessionRuntimeByIdAtom } from "../atoms";

export type BiosEndpointFacts = {
	readonly provider: string | null;
	readonly modelId: string | null;
	readonly modelName: string | null;
	readonly endpointOrigin: string | null;
	/**
	 * D4：当前 runtime 的定位（agentId + 代次 + 会话 ID）。
	 *
	 * 渲染层只把它当作**引用**提交给主进程；provider/model/地址一律由主进程按这个引用去
	 * 读真实运行态，renderer 提交的身份不参与授权。
	 */
	readonly agentId: string | null;
	readonly generation: number | null;
	readonly sessionId: string | null;
};

const EMPTY: BiosEndpointFacts = { provider: null, modelId: null, modelName: null, endpointOrigin: null, agentId: null, generation: null, sessionId: null };

/** 当前会话正在使用的模型（provider / modelId / 显示名）；没有运行中会话时全为 null。 */
export function useBiosEndpointFacts(): BiosEndpointFacts {
	const sessionId = useAtomValue(currentSessionIdAtom);
	const runtimes = useAtomValue(sessionRuntimeByIdAtom);
	return useMemo(() => {
		const runtime = sessionId === undefined ? undefined : runtimes[sessionId];
		const state = runtime?.state;
		if (sessionId === undefined || state === undefined || state === null) return EMPTY;
		return {
			provider: state.provider ?? null,
			modelId: state.modelId ?? null,
			modelName: state.modelName ?? null,
			endpointOrigin: state.modelEndpointOrigin ?? null,
			agentId: runtime?.agentId ?? null,
			generation: runtime?.runtimeGeneration ?? null,
			sessionId,
		};
	}, [runtimes, sessionId]);
}
