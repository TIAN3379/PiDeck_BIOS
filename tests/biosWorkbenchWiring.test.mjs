/**
 * BM-07B B-03 永久回归：**BIOS 工作台抽屉入口的接线契约**。
 *
 * 新增一个抽屉 kind 会同时受"类型联合 / 持久化白名单 / 渲染分发 / 活动栏 / 装配"五处约束，
 * 漏掉任何一处都会表现为"点了没反应"或"重启后抽屉被丢弃"。这里逐处钉住，
 * 并保证既有 files/git/browser 行为没被改（仍然走原分支）。
 *
 * 另加**行为级**断言：任务/知识区必须是诚实占位（不能有假表单），以及双语字典齐全。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const read = (path) => readFileSync(path, "utf8");
const panels = read("src/renderer/src/hooks/useWorkspacePanels.ts");
const surface = read("src/renderer/src/components/workspace/DrawerSurface.tsx");
const ports = read("src/renderer/src/hooks/useDrawerPorts.ts");
const app = read("src/renderer/src/App.tsx");
const biosTab = read("src/renderer/src/components/app/settings/BiosTab.tsx");

test("UI-MIN: service receipt has one root owner independent of drawer summaries", () => {
	const overview = read("src/renderer/src/components/bios/BiosWorkflowOverview.tsx");
	assert.doesNotMatch(overview, /<BiosFirstRunGate/);
	assert.equal((app.match(/<BiosFirstRunGate\b/g) ?? []).length, 1);
	assert.doesNotMatch(app.match(/<BiosFirstRunGate[^>]+>/)?.[0] ?? "", /suppressed=/);
});

test("F3: BIOS restart entrances handle detached sessions, not only live agents", () => {
	assert.match(app, /onRestartBiosRuntime: \(\) => currentSessionId && void restartSessionAnyState\(currentSessionId\)/);
	assert.match(app, /<BiosFirstRunGate[^\n]+onRestartRuntime=\{\(\) => currentSessionId && void restartSessionAnyState\(currentSessionId\)\}/);
});

const { zhCN } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
const { enUS } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts");

test("B-03：抽屉类型联合与持久化白名单都包含 bios（否则重启后被静默丢弃）", () => {
	assert.match(panels, /export type WorkspaceDrawerPanel = [^;]*"bios"/);
	// allow-list 是唯一会丢弃未知 kind 的地方：必须与联合类型同源。
	const allowList = panels.match(/const validPanel = panel === null \|\| \[([^\]]+)\]/);
	assert.ok(allowList, "必须存在持久化白名单");
	assert.match(allowList[1], /"bios"/);
	// 既有 kind 一个都不能少（防手滑改坏 restore 行为）。
	for (const kind of ["files", "sessions", "browser", "git", "trajectory", "rewind"]) {
		assert.match(allowList[1], new RegExp(`"${kind}"`));
	}
});

test("B-03：渲染分发把 bios 挂到工作台，且不改既有面板分支", () => {
	assert.match(surface, /drawer === "bios" && !drawerCollapsed/);
	assert.match(surface, /<BiosWorkbenchPanel/);
	assert.match(surface, /bios\.desktopProjectId/);
	// 一次只渲染一个面板：新分支必须仍在三元链里（不能新增独立 return 破坏排他性）。
	assert.match(surface, /\{drawer === "trajectory" && !drawerCollapsed \?/);
	assert.match(surface, /\) : drawer === "bios" && !drawerCollapsed \?/);
	assert.match(surface, /\) : drawer === "browser" && !drawerCollapsed \?/);
	// 只拿身份，不拿路径：端口里不得出现 path。
	assert.match(surface, /export interface DrawerBiosPort \{\n\tdesktopProjectId/);
	assert.doesNotMatch(surface.slice(surface.indexOf("export interface DrawerBiosPort"), surface.indexOf("export interface DrawerChromePort")), /path/);
});

test("B-03：装配层把当前桌面项目身份接进 bios 端口", () => {
	assert.match(ports, /import type \{[^}]*DrawerBiosPort[^}]*\}/);
	assert.match(ports, /const bios: DrawerBiosPort = \{/);
	assert.match(ports, /desktopProjectId: isChatProject\([^\n]+\) \? undefined : input\.activeProjectId/);
	assert.match(app, /<BiosFirstRunGate desktopProjectId=\{isChatProject\(activeProject\) \? undefined : activeProjectId\}/);
	assert.match(ports, /desktopProjectName: input\.projects\.find/);
	assert.match(ports, /return \{ git, chrome, browser, files, bios \}/);
});

test("B-03：活动栏有 BIOS 工作台入口，且从别处只能请求打开", () => {
	// rail 项：id/label/图标/激活态/统一 toggle 语义
	assert.match(app, /id: "bios",\s*\n\s*label: t\("bios\.workbench\.title"\),\s*\n\s*icon: <CircuitBoard size=\{16\} \/>,\s*\n\s*active: drawer === "bios",\s*\n\s*onClick: \(\) => handleToolDrawerAction\("bios"\)/);
	// 端口透传给 DrawerSurface
	assert.match(app, /bios=\{drawerPorts\.bios\}/);
	// 跨界面"请求打开"：消费后立即清空，且用 openDrawerForce（不是 toggle）
	assert.match(app, /workspaceDrawerRequestAtom/);
	assert.match(app, /setDrawerRequest\(null\);\s*\n\s*workspace\.openDrawerForce\(drawerRequest\)/);
	// 设置页入口：有未保存草稿时不关设置（不静默丢改动）
	assert.match(biosTab, /requestDrawer\("bios"\)/);
	assert.match(biosTab, /if \(dirty\) \{/);
	assert.match(biosTab, /closeSettings\(false\)/);
});

test("B-03：工作台模块存在，三个业务区都由真组件承载（不再有占位）", () => {
	for (const file of ["BiosWorkbenchPanel.tsx", "BiosStoreGate.tsx", "BiosProjectSection.tsx", "BiosProjectDetail.tsx", "BiosTaskSection.tsx", "BiosKnowledgeSection.tsx", "BiosValidationEditor.tsx", "validationDrafts.ts"]) {
		assert.ok(existsSync(`src/renderer/src/components/bios/${file}`), `缺少 ${file}`);
	}
	assert.ok(existsSync("src/renderer/src/hooks/useBiosWorkbench.ts"));

	const panel = read("src/renderer/src/components/bios/BiosWorkbenchPanel.tsx");
	// 三个业务区都要有入口
	for (const section of ["projects", "tasks", "knowledge"]) {
		assert.match(panel, new RegExp(`id: "${section}"`));
	}
	assert.match(panel, /<BiosTaskSection tasks=\{tasks\} workspaces=\{projectWorkspaces\} profileRevision=\{selectedProject\?\.profileRevision \?\? null\} onDirtyChange=\{setTaskDirty\} \/>/);
	assert.match(panel, /<BiosKnowledgeSection[\s\S]{0,200}canAddReference=\{tasks\.selectedTaskId !== null\}/);
	// B-06：任务状态提升到面板层，两个区看到**同一个**选中任务（避免"加到别的任务上"）。
	assert.match(panel, /const tasks = useBiosTasks\(\{ projectId: workbench\.selectedProjectId \}\)/);
	// 占位组件已随 B-05 退场：不允许再留"尚未交付"的假面板。
	assert.equal(existsSync("src/renderer/src/components/bios/BiosPendingSection.tsx"), false);
	assert.doesNotMatch(panel, /BiosPendingSection/);

	// 建库必须二次确认（不是点一下就直接写盘）
	const gate = read("src/renderer/src/components/bios/BiosStoreGate.tsx");
	assert.match(gate, /<ConfirmDialog/);
	assert.match(gate, /onConfirm=\{\(\) => \{\s*\n\s*setConfirming\(false\);\s*\n\s*void workbench\.createStore\(\);/);
	// 六种状态都要有界面分支
	for (const kind of ["unconfigured", "directory-missing", "not-initialized", "ready", "future-version", "corrupt", "unreachable"]) {
		assert.match(gate, new RegExp(`"${kind}"`), `缺少状态分支 ${kind}`);
	}
	// 损坏/未来版本必须显式写"不覆盖、不自动迁移"
	assert.match(gate, /bios\.workbench\.store\.noTouchHint/);
});

test("B-04：任务区接线——状态变更与正文保存分开，选中任务不暗开上下文，未保存有守卫", () => {
	for (const file of ["BiosTaskSection.tsx", "tasks/BiosTaskList.tsx", "tasks/BiosTaskDetail.tsx", "tasks/BiosTaskForm.tsx", "tasks/biosTaskDrafts.ts"]) {
		assert.ok(existsSync(`src/renderer/src/components/bios/${file}`), `缺少 ${file}`);
	}
	const hook = read("src/renderer/src/hooks/useBiosTasks.ts");
	const list = read("src/renderer/src/components/bios/tasks/BiosTaskList.tsx");
	const detail = read("src/renderer/src/components/bios/tasks/BiosTaskDetail.tsx");
	const form = read("src/renderer/src/components/bios/tasks/BiosTaskForm.tsx");
	const section = read("src/renderer/src/components/bios/BiosTaskSection.tsx");

	// 读取有界：主进程与渲染层共用同一个上限常量，渲染层据此提示"可能被截断"。
	assert.match(read("src/main/bios/BiosKnowledgeService.ts"), /BIOS_TASK_LIST_LIMIT/);
	assert.match(read("src/shared/biosLimits.ts"), /export const BIOS_TASK_LIST_LIMIT = 200/);
	assert.match(hook, /items\.length >= BIOS_TASK_LIST_LIMIT/);
	assert.match(list, /truncated/);

	// 选中只是候选：列表行不得触发 applySelection；上下文只由详情里的显式按钮走 ACK 链路。
	assert.doesNotMatch(list, /applySelection|applyContext/);
	assert.match(hook, /const request = \{ \.\.\.claim, projectId, taskId, workspaceId, contextEnabled: enabled \}/);
	assert.match(hook, /desktopApi\.bios\.applySelection\(request\)/);
	assert.match(detail, /onApplyContext/);

	// 状态变更与正文保存分开：表单里没有状态字段，也只有详情能改状态。
	assert.doesNotMatch(form, /changeTaskStatus|statusReason/);
	assert.match(hook, /desktopApi\.bios\.updateTask\(/);
	assert.match(hook, /desktopApi\.bios\.changeTaskStatus\(/);

	// 显式重开：done → in_progress 必须给理由，且说明验证不会被清空。
	assert.match(detail, /const reopening = task\.status === "done" && target === "in_progress"/);
	assert.match(detail, /props\.busy \|\| reason\.trim\(\) === ""/);
	assert.match(detail, /reopenHint/);
	assert.doesNotMatch(detail, /validations: \[\]/, "重开绝不能清空验证记录");

	// 未保存守卫 + CAS 冲突保留表单。
	assert.match(section, /<ConfirmDialog/);
	assert.match(section, /if \(dirty\) \{/);
	assert.match(section, /conflicted \? <div className="text-destructive">/, "冲突必须显著提示");
	assert.match(hook, /await selectTask\(taskId, epoch\);[\s\S]{0,100}patch\(\{ writeOutcome: outcome\.result/, "同一次保存的刷新不能失效自己的回执（另有回调行为测试）");

	// 视图过滤只作用于已取回的窗口（不为筛选而全库扫描）。
	assert.match(hook, /const visibleItems = useMemo\(\(\) => \(state\.statusFilter === "all" \? state\.items : state\.items\.filter/);
});

test("B-05：知识区接线——无直接改状态的入口、跨项目参考只作参考、不可完整结果必须提示", () => {
	for (const file of [
		"BiosKnowledgeSection.tsx",
		"knowledge/BiosSearchPane.tsx",
		"knowledge/BiosReferenceCard.tsx",
		"knowledge/BiosFeaturePane.tsx",
		"knowledge/BiosFeatureForm.tsx",
		"knowledge/BiosExperiencePane.tsx",
		"knowledge/BiosExperienceForm.tsx",
		"knowledge/BiosClassBadge.tsx",
		"knowledge/biosKnowledgeDrafts.ts",
	]) {
		assert.ok(existsSync(`src/renderer/src/components/bios/${file}`), `缺少 ${file}`);
	}
	const hook = read("src/renderer/src/hooks/useBiosKnowledge.ts");
	const reference = read("src/renderer/src/components/bios/knowledge/BiosReferenceCard.tsx");
	const experience = read("src/renderer/src/components/bios/knowledge/BiosExperiencePane.tsx");
	const search = read("src/renderer/src/components/bios/knowledge/BiosSearchPane.tsx");
	const feature = read("src/renderer/src/components/bios/knowledge/BiosFeaturePane.tsx");
	const badge = read("src/renderer/src/components/bios/knowledge/BiosClassBadge.tsx");
	const drafts = read("src/renderer/src/components/bios/knowledge/biosKnowledgeDrafts.ts");

	// 审核只走五个动作；没有"直接写 status/verified"的入口。
	assert.match(experience, /const ACTIONS: readonly \{ action: AuditAction; danger: boolean \}\[\] = \[/);
	for (const action of ["submit-review", "request-changes", "approve", "deprecate", "restore"]) {
		assert.match(experience, new RegExp(`action: "${action}"`), `缺少审核动作 ${action}`);
	}
	assert.doesNotMatch(hook, /status:\s*"verified"/);
	assert.doesNotMatch(experience, /createExperience\(\{[\s\S]{0,200}status/);
	// 危险动作二次确认 + 真实 expectedRevision。
	assert.match(experience, /selectedAction\.danger \? setConfirming\(true\) : submitReview\(\)/);
	assert.match(experience, /<ConfirmDialog/);
	assert.match(hook, /reviewExperience\(\{ \.\.\.context\.claim, experienceId, expectedRevision, action, reason/);
	// 只有 draft 可编辑正文。
	assert.match(experience, /card\.status === "draft"/);
	assert.match(experience, /editOnlyDraft/);

	// 跨项目参考：只作参考 + 源板验证不等于目标板已验证。
	assert.match(reference, /view\.porting\.needsPortingReview/);
	assert.match(reference, /reference\.declaredValidations/);
	assert.match(reference, /portingNote/);
	// 免责声明必须真的出现在两种语言的用户可见文案里（不是只写在注释里）。
	assert.match(zhCN["bios.workbench.knowledge.reference.portingNote"], /不代表目标板已验证/);
	assert.match(enUS["bios.workbench.knowledge.reference.portingNote"], /never means the target board is verified/);
	assert.match(zhCN["bios.workbench.knowledge.reference.declaredValidationsHint"], /只属于来源项目/);

	// 不完整/读取失败必须提示，不能当作"没有匹配"。
	assert.match(hook, /searchResult\.status === "incomplete" \|\| state\.searchResult\.matchedButDropped > 0 \|\| state\.searchResult\.unreadable > 0/);
	assert.match(search, /knowledge\.searchIncomplete/);
	assert.match(search, /decisionIncomplete/);

	// 六类 M1 分类可视化区分（不是一套样式糊过去）。
	for (const key of ["current", "reference", "needsReview", "conflict", "history", "excluded", "unknown"]) {
		assert.match(badge, new RegExp(`"bios\\.workbench\\.knowledge\\.class\\.${key}"`), `缺少分类标签 ${key}`);
	}

	// 需求写入的初次授权：失败要指向设置，而不是"重试"。
	assert.match(feature, /authorizationHint/);
	assert.match(drafts, /toFeatureFieldInput/);
	assert.match(drafts, /if \(value === "" && !hasEvidence\) return undefined/, "空值必须省略而不是写成假字段");
	assert.match(read("src/renderer/src/components/bios/knowledge/BiosFeatureForm.tsx"), /空值保持未知|fieldHint/);
});

test("B-06：沉淀/接续接线——只补回链、默认关上下文、清单保存只基于预览、不提供发送按钮", () => {
	for (const file of ["tasks/BiosSedimentPane.tsx", "tasks/BiosContinuationPane.tsx", "tasks/biosSedimentDrafts.ts"]) {
		assert.ok(existsSync(`src/renderer/src/components/bios/${file}`), `缺少 ${file}`);
	}
	const sediment = read("src/renderer/src/components/bios/tasks/BiosSedimentPane.tsx");
	const sedimentDrafts = read("src/renderer/src/components/bios/tasks/biosSedimentDrafts.ts");
	const continuation = read("src/renderer/src/components/bios/tasks/BiosContinuationPane.tsx");
	const continuationHook = read("src/renderer/src/hooks/useBiosContinuation.ts");
	const main = read("src/main/bios/BiosBusinessService.ts");
	const taskSection = read("src/renderer/src/components/bios/BiosTaskSection.tsx");

	// 沉淀：预填只来自已保存任务；人工必填字段逐项呈现；不补造根因/方案。
	assert.match(sedimentDrafts, /prefill\.suggested\.requirement/);
	assert.match(sedimentDrafts, /requiredHumanFields/);
	assert.doesNotMatch(sedimentDrafts, /rootCause:\s*"/, "预填不得给根因填默认值");
	assert.doesNotMatch(sedimentDrafts, /solution:\s*"/, "预填不得给方案填默认值");
	assert.match(sediment, /requiredHumanFieldsOf\(prefill\)/);

	// 回链冲突：只补回链（不重新 saveDraft → 不会变成第二张卡）。
	assert.match(sediment, /tasks\.changeReferences\(outcome\.experienceId, true\)/);
	assert.match(sediment, /outcome\.status === "link-conflict" \|\| outcome\.status === "link-failed"/);
	assert.match(sediment, /bios\.workbench\.sediment\.linkOnly/);

	// 接续：默认关上下文；要开必须显式第二个动作。
	assert.match(continuation, /tasks\.applyContext\(false\)/);
	assert.match(continuation, /tasks\.applyContext\(true\)/);
	assert.match(continuation, /defaultOffHint/);
	// 本地交接与模型可发送分开；没有"发送给模型"的按钮。
	assert.match(continuation, /maySendToModel/);
	assert.match(continuation, /localCopyWarning/);
	assert.doesNotMatch(continuation, /sendToModel\(|sendPrompt\(/, "不得提供把本地正文发给模型的入口");
	assert.match(continuation, /noSendButton/);

	// 清单保存只基于刚刚生成的预览：来源/预算/时间都派生自 preview。
	assert.match(continuationHook, /sources: preview\.retainedSources\.map/);
	assert.match(continuationHook, /generatedAt,/);
	assert.match(continuationHook, /budget: \{ maxChars: preview\.budget\.maxChars/);
	assert.match(continuationHook, /preview === null \|\| !preview\.stable \|\| generatedAt === null \|\| scope === null \|\| scope\.taskId !== input\.taskId/);
	// 主进程不再"尚未开放"：真的走 core 的保存/重验（含服务端重读来源）。
	assert.doesNotMatch(main, /尚未开放/);
	assert.match(main, /saveContextManifest\(\{/);
	assert.match(main, /verifyContextManifest\(\{/);
	assert.match(main, /authorizedRoots: settings\.authorizedRoots,[\s\S]{0,400}authorizedProjectIds: settings\.authorizedProjectIds/);

	// 任务区把沉淀/接续都接入（不是隐藏入口）。
	assert.match(taskSection, /tab === "continuation"\s*\?\s*\(?\s*<BiosContinuationPane/);
	assert.match(taskSection, /mode === "sediment" && detail\?\.task != null \?/);
	assert.match(read("src/renderer/src/components/bios/tasks/BiosTaskDetail.tsx"), /onSediment/);
});

test("B-07：备份/恢复薄入口——确认来自人、只报阶段、恢复不改配置", () => {
	const sectionPath = "src/renderer/src/components/app/settings/BiosBackupSection.tsx";
	assert.ok(existsSync(sectionPath), "缺少独立备份组件");
	assert.ok(existsSync("src/renderer/src/hooks/useBiosBackup.ts"));
	const section = read(sectionPath);
	const hook = read("src/renderer/src/hooks/useBiosBackup.ts");
	const service = read("src/main/bios/BiosBusinessService.ts");
	const ipc = read("src/main/ipc/biosBusinessIpc.ts");
	const tab = read("src/renderer/src/components/app/settings/BiosTab.tsx");

	// 组件独立挂在 BIOS 设置里（不与桌面聊天配置备份混称为同一格式）。
	assert.match(tab, /<BiosBackupSection \/>/);
	assert.match(section, /知识库备份与桌面聊天配置备份不是同一格式|backup\.scopeHint/);

	// 离线声明必须由人勾选：四个勾选初始都是 false，且按钮被它们门控。
	for (const state of ["exportAppQuiet", "exportExternalClosed", "restoreSourceStable", "restoreTargetFree"]) {
		assert.match(section, new RegExp(`\\[${state}, set[A-Za-z]+\\] = useState\\(false\\)`), `${state} 不得有默认勾选`);
	}
	assert.match(section, /exportAppQuiet && exportExternalClosed/);
	assert.match(section, /restoreSourceStable && restoreTargetFree/);
	// 完成/失败后重新确认（离线声明只对"这一次操作"有效）。
	assert.match(section, /setExportAppQuiet\(false\)/);
	assert.match(section, /setRestoreSourceStable\(false\)/);
	// 渲染层不得预先确认：没有 offlineConfirmed: true 这种字面量。
	assert.doesNotMatch(section, /offlineConfirmed: true/);
	assert.doesNotMatch(hook, /offlineConfirmed: true/);
	assert.match(hook, /offlineConfirmed \}\);/, "只把调用方（人工）的确认原样传给服务层");

	// 服务层在调用 core 之前必须自己拒一次，且 IPC 只认布尔 true。
	assert.match(service, /if \(request\.offlineConfirmed !== true\) \{/);
	assert.match(ipc, /offlineConfirmed: input\.offlineConfirmed === true/);
	assert.match(service, /exportKnowledgeBackup\(\{ root, backupRoot, offlineConfirmed: true, now: this\.now\(\) \}\)/);
	assert.match(service, /restoreKnowledgeBackup\(\{ backupRoot: request\.backupRoot, root, offlineConfirmed: true \}\)/);

	// 目标由"父目录 + 单段名字"拼：逃逸/保留名在拼接前挡住；存在性/重叠/链接仍归 core。
	assert.match(service, /private resolveBackupTarget\(parentDir: string, name: string\): string \{/);
	assert.match(service, /isFullyQualifiedPath\(parentDir\)/);
	assert.match(service, /Windows 保留设备名/);
	assert.doesNotMatch(service, /backup-target-overlap|backup-target-exists/, "不得在渲染/适配层重写 core 的重叠与存在判据");

	// 进度只报阶段：没有进度条组件、没有自算百分比，并且明说"协议没有百分比"。
	assert.doesNotMatch(section, /<Progress/);
	assert.doesNotMatch(section, /\d+\s*%/, "不得出现硬编码百分比");
	assert.doesNotMatch(hook, /<Progress|\* 100/);
	assert.match(section, /backup\.noPercent/);

	// 恢复完成不改配置：本组件/钩子不碰设置写入入口。
	assert.doesNotMatch(hook, /updateBiosSettings|updateSettings|knowledgeRoot:/);
	assert.doesNotMatch(section, /updateBiosSettings|updateSettings/);
	assert.match(section, /backup\.noAutoSwitch/);
	assert.match(section, /reviewReasons/);
	assert.match(section, /cleanupNotRollback/);
});

test("B-08：GUI 实测的稳定选择器（e2e/bios-workbench.spec.ts 依赖）", () => {
	// 这些 data-testid 是 e2e 的唯一契约：改名/删除要让 B-08 的 GUI 用例立刻可见地红，
	// 而不是等到"人工点测时才发现点不到"。
	const expectations = [
		["src/renderer/src/components/bios/BiosWorkbenchPanel.tsx", ['data-testid="bios-workbench"', "data-testid={`bios-workbench-section-${entry.id}`}"]],
		["src/renderer/src/components/bios/BiosStoreGate.tsx", ['data-testid="bios-store-ready"']],
		["src/renderer/src/components/bios/BiosProjectSection.tsx", ['data-testid="bios-project-section"', "data-testid={`bios-project-row-${project.projectId}`}"]],
		["src/renderer/src/components/bios/BiosTaskSection.tsx", ['data-testid="bios-task-section"']],
		[
			"src/renderer/src/components/app/settings/BiosBackupSection.tsx",
			['data-testid="bios-backup-section"', '"bios-backup-consent-app-quiet"', '"bios-backup-consent-external-closed"', '"bios-backup-consent-source-stable"', '"bios-backup-consent-target-free"', 'data-testid="bios-backup-export-run"', 'data-testid="bios-backup-restore-run"'],
		],
	];
	for (const [file, needles] of expectations) {
		const source = read(file);
		for (const needle of needles) assert.ok(source.includes(needle), `${file} 缺少 ${needle}`);
	}
	// e2e 夹具与用例都在（且用例只有在设了可执行文件时才跑包内那条）。
	assert.ok(existsSync("e2e/biosWorkbenchSeed.mjs"));
	assert.ok(existsSync("e2e/bios-workbench.spec.ts"));
	assert.ok(existsSync("e2e/bios-packaged-shell.spec.ts"));
});

test("B-03：双语字典含工作台全部静态键（含 13 个可确认字段标签）", () => {
	const keys = [
		"bios.workbench.title",
		"bios.workbench.loading",
		"bios.workbench.refresh",
		"bios.workbench.noSession",
		"bios.workbench.gotoSettings",
		"bios.workbench.gotoAuthorization",
		"bios.workbench.runtimeStopFailures",
		"bios.workbench.section.projects",
		"bios.workbench.section.tasks",
		"bios.workbench.section.knowledge",
		"bios.workbench.store.create",
		"bios.workbench.store.createConfirmMessage",
		"bios.workbench.store.noTouchHint",
		"bios.workbench.project.register",
		"bios.workbench.project.listGap",
		"bios.workbench.detail.vcsChanged",
		"bios.workbench.detect.truncated",
		"bios.workbench.confirm.submit",
		"bios.workbench.pending.tasksHint",
		"settings.bios.workbenchOpen",
		"bios.workbench.task.listTitle",
		"bios.workbench.task.truncated",
		"bios.workbench.task.listMeta",
		"bios.workbench.task.validations",
		"bios.workbench.task.reopen",
		"bios.workbench.task.reopenHint",
		"bios.workbench.task.contextOn",
		"bios.workbench.task.unsavedMessage",
		"bios.workbench.task.conflictHint",
		"bios.workbench.task.errorValidation",
		// B-05 / B-06 / B-07 的代表性文案（完整逐键对齐由 rendererProductCopyI18n 保证）。
		"bios.workbench.knowledge.reference.portingNote",
		"bios.workbench.knowledge.experience.confirmRun",
		"bios.workbench.sediment.linkOnly",
		"bios.workbench.continuation.noSendButton",
		"bios.workbench.backup.sensitiveTitle",
		"bios.workbench.backup.consentNotProvable",
		"bios.workbench.backup.noPercent",
		"bios.workbench.backup.cleanupNotRollback",
		"bios.workbench.backup.noAutoSwitch",
		"bios.workbench.backup.failureHint",
	];
	const fields = ["ibv", "ibvVersion", "chipsetVendor", "chipsetFamily", "chipsetGeneration", "architecture", "boardName", "boardRevision", "customer", "productLine", "crbBaseline", "buildTargets", "keyEntryPoints"];
	for (const key of [...keys, ...fields.map((field) => `bios.workbench.field.${field}`)]) {
		assert.ok(Object.hasOwn(zhCN, key), `zh-CN 缺少 ${key}`);
		assert.ok(Object.hasOwn(enUS, key), `en-US 缺少 ${key}`);
	}
});
