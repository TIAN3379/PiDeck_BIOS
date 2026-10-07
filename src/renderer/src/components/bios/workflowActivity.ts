/** 只投影本会话 BIOS 工具的名称/状态，不复制正文或把工具结束误当保存成功。 */
import type { ChatMessage } from "../../../../shared/types/session";
import { biosWorkflowResultState } from "../../../../shared/biosWorkflowReceipt";
export function projectWorkflowActivity(messages: readonly ChatMessage[]) {
	return messages
		.slice(-200)
		.filter((m) => m.role === "tool" && typeof m.meta?.toolName === "string" && m.meta.toolName.startsWith("bios_"))
		.slice(-6)
		.reverse()
		.map((m) => {
			const receipt = m.meta?.biosWorkflowState;
			const projected = receipt === "saved" || receipt === "read" || receipt === "attention" ? receipt : biosWorkflowResultState(m.meta?.result);
			const state: "running" | "saved" | "read" | "attention" = m.meta?.status === "running" ? "running" : m.meta?.isError === true ? "attention" : (projected ?? "read");
			return { id: m.id, toolName: String(m.meta?.toolName), state, timestamp: m.timestamp };
		});
}
