/**
 * BM-07B B-08 GUI 实测夹具：**合成知识库 + 合成工作区**（全程离线、无客户数据）。
 *
 * 为什么单独一份而不是直接调 `biosGuiSeed.mjs`：Playwright 侧需要"先有工作区目录、
 * 再按该路径绑定"，并且要把 `biosHost` 授权集合写进**测试自己的** `settings.json`
 * （由 mock-pi fixture 负责），所以这里只做"库 + 绑定 + 合成记录"，返回主进程需要的 ID。
 *
 * 用法：`node e2e/biosWorkbenchSeed.mjs --root <知识根> --workspace <工作区>`，
 * stdout 只输出一行 JSON：`{ projectId, workspaceId, profileRevision, root, workspace }`。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { initializeKnowledgeStore } from "../packages/bios-agent/core/storage/index.ts";
import { bindProjectWorkspace, confirmProfileFields } from "../packages/bios-agent/core/projects/index.ts";
import { createTask, changeTaskStatus } from "../packages/bios-agent/core/tasks/index.ts";

/** 合成 DSC：通用 EDK II 形状，不含任何客户/板卡真实信息。 */
async function writeSyntheticDsc(workspace) {
	await writeFile(join(workspace, "SyntheticBoard.dsc"), "[Defines]\n PLATFORM_NAME = SyntheticBoard\n SUPPORTED_ARCHITECTURES = X64\n BUILD_TARGETS = DEBUG\n");
}

function argument(name) {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

const root = resolve(argument("root") ?? "");
const workspace = resolve(argument("workspace") ?? "");
if (!argument("root") || !argument("workspace")) throw new Error("Provide --root <knowledge root> and --workspace <workspace>.");
if (existsSync(root) && existsSync(join(root, "registry.json"))) throw new Error(`Refusing to replace an existing knowledge store: ${root}`);

await mkdir(workspace, { recursive: true });
await mkdir(root, { recursive: true });
await writeSyntheticDsc(workspace);

const initialized = await initializeKnowledgeStore({ root });
const binding = await bindProjectWorkspace({ root, cwd: workspace, workspacePath: workspace, authorizedRoots: [workspace] });
await confirmProfileFields({
	root,
	projectId: binding.projectId,
	expectedProfileRevision: binding.profileRevision,
	workspaceId: binding.workspaceId,
	operatorLabel: "synthetic GUI fixture",
	values: [
		{ field: "ibv", value: "AMI" },
		{ field: "chipsetVendor", value: "Intel" },
		{ field: "boardName", value: `SYNTHETIC-${basename(workspace)}` },
	],
});

// 两条任务：一条保持 open（可推进状态），一条 done（验证"完成"与"显式重开"的区别）。
const openTask = await createTask({ root, projectId: binding.projectId, taskId: "gui-open-task", workspaceId: binding.workspaceId, cwd: workspace, authorizedRoots: [workspace], authorizedProjectIds: [binding.projectId], requirement: "SYNTHETIC-GUI: 验证任务区只读展示" });
const doneTask = await createTask({ root, projectId: binding.projectId, taskId: "gui-done-task", workspaceId: binding.workspaceId, cwd: workspace, authorizedRoots: [workspace], authorizedProjectIds: [binding.projectId], requirement: "SYNTHETIC-GUI: 已推进到完成的任务" });
await changeTaskStatus({
	root,
	projectId: binding.projectId,
	taskId: "gui-done-task",
	expectedRevision: doneTask.revision,
	to: "done",
	operatorLabel: "synthetic GUI fixture",
	reason: "synthetic status transition for the GUI fixture",
	authorizedProjectIds: [binding.projectId],
});

process.stdout.write(
	`${JSON.stringify({
		projectId: binding.projectId,
		workspaceId: binding.workspaceId,
		profileRevision: binding.profileRevision,
		root,
		workspace,
		status: initialized.status,
		taskRevision: openTask.revision,
	})}\n`,
);
