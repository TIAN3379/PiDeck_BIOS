/** Fresh synthetic knowledge/profile for real Pi + Electron GUI checks; no customer data. */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeKnowledgeStore } from "../packages/bios-agent/core/storage/index.ts";
import { bindProjectWorkspace, confirmProfileFields } from "../packages/bios-agent/core/projects/index.ts";
import { createTask } from "../packages/bios-agent/core/tasks/index.ts";

export async function seedBiosGui(base, port, options = {}) {
	base = resolve(base);
	if (existsSync(base)) throw new Error(`Refusing to replace existing GUI profile: ${base}`);
	const repo = fileURLToPath(new URL("..", import.meta.url));
	const profile = join(base, "profile");
	// Explicit opt-in real workspace: only bind/read it; all fixture facts remain in isolated knowledge.
	const workspace = options.existingWorkspace ? resolve(options.existingWorkspace) : join(base, "SyntheticBoard");
	const root = join(base, "knowledge");
	const agentDir = join(base, ".pi", "agent");
	for (const dir of [profile, ...(options.existingWorkspace ? [] : [workspace]), agentDir, join(base, "AppData", "Roaming"), join(base, "AppData", "Local"), join(base, "Documents"), join(base, "Desktop")]) await mkdir(dir, { recursive: true });
	if (!options.existingWorkspace)
		await writeFile(
			join(workspace, "Synthetic.dsc"),
			"[Defines]\n PLATFORM_NAME = SyntheticBoard\n PLATFORM_GUID = 22222222-2222-2222-2222-222222222222\n PLATFORM_VERSION = 1.0\n DSC_SPECIFICATION = 0x0001001B\n OUTPUT_DIRECTORY = Build\n SUPPORTED_ARCHITECTURES = X64\n BUILD_TARGETS = DEBUG\n SKUID_IDENTIFIER = DEFAULT\n",
		);
	await initializeKnowledgeStore({ root });
	const binding = await bindProjectWorkspace({ root, cwd: workspace, workspacePath: workspace, authorizedRoots: [workspace], ...(options.desktopProjectId === undefined ? {} : { desktopProjectId: options.desktopProjectId }) });
	await confirmProfileFields({
		root,
		projectId: binding.projectId,
		expectedProfileRevision: binding.profileRevision,
		workspaceId: binding.workspaceId,
		operatorLabel: "synthetic GUI fixture",
		values: [
			{ field: "ibv", value: "AMI" },
			{ field: "chipsetVendor", value: "Intel" },
			{ field: "boardName", value: "SYNTHETIC-NOT-A-CUSTOMER" },
		],
	});
	for (const taskId of ["gui-task-a", "gui-task-b"]) await createTask({ root, projectId: binding.projectId, taskId, workspaceId: binding.workspaceId, cwd: workspace, authorizedRoots: [workspace], authorizedProjectIds: [binding.projectId], requirement: `SYNTHETIC-GUI-${taskId}: verify the BIOS panel only` });
	await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "bios-test": { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "synthetic-offline-key", models: [{ id: "bios-test-model", name: "Synthetic offline model", contextWindow: 32768, maxTokens: 2048 }] } } }));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "bios-test", defaultModel: "bios-test-model" }));
	// AW-09：可选打开宿主自动化许可（缺省不写 = 保持既有手动行为）。
	const biosHost = {
		knowledgeRoot: root,
		authorizedProjectIds: [binding.projectId],
		allowedFeatureIds: [],
		approvedCustomers: [],
		authorizedRoots: [workspace],
		endpoint: "allowed",
		...(options.automation === true ? { automation: { enabled: true, localBookkeeping: true, injectProjectData: true, version: 1 } } : {}),
	};
	await writeFile(
		join(profile, "settings.json"),
		JSON.stringify({ customPiPath: join(repo, "packages", "bios-agent", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"), piEnvironmentChecked: true, lastUsedModel: { provider: "bios-test", modelId: "bios-test-model" }, biosHost, checkUpdatesOnStartup: false }),
	);
	await writeFile(join(profile, "projects.json"), JSON.stringify([{ id: "synthetic-gui", name: "Synthetic BIOS GUI", path: workspace, lastOpenedAt: Date.now(), sortOrder: 0 }]));
	return { base, profile, workspace, root, agentDir, projectId: binding.projectId, workspaceId: binding.workspaceId, biosHost };
}
