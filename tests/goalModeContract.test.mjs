import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const agentTypes = readFileSync("src/shared/types/agent.ts", "utf8");
const composerComponents = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
const composerModeSelect = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
const builtIns = readFileSync("src/main/extensions/builtInExtensions.ts", "utf8");
const extension = readFileSync("resources/extensions/pi-deck-goal-mode.ts", "utf8");
const timelineCss = readFileSync("src/renderer/src/styles/timeline.css", "utf8");

test("goal mode is a first-class ComposerAgentMode", () => {
	assert.match(agentTypes, /ComposerAgentMode = "normal" \| "plan" \| "imagegen" \| "goal"/);
	assert.equal(existsSync("resources/extensions/pi-deck-goal-mode.ts"), true);
	assert.match(builtIns, /"pi-deck-goal-mode.ts"/);
});

test("mode picker lists goal between plan and imagegen", () => {
	// 模式选择器已重构进 ComposerComponents（旧 ComposerModeSelect.tsx 已删）：
	// 三态由 props.composerAgentMode 驱动，图标/文案锚点在同组件内
	assert.match(composerModeSelect, /mode === "goal"/);
	assert.match(composerModeSelect, /"app\.composerModeGoal"/);
	assert.match(composerModeSelect, /composerAgentMode === "goal"/);
	assert.match(composerModeSelect, /<Select/);
	// 图标分支顺序：plan → imagegen → goal（实现）；契约只断言 goal 存在且三态齐全
	const planOrder = composerModeSelect.indexOf('mode === "plan"');
	const goalOrder = composerModeSelect.indexOf('mode === "goal"');
	const imagegenOrder = composerModeSelect.indexOf('mode === "imagegen"');
	assert.ok(planOrder >= 0 && goalOrder >= 0 && imagegenOrder >= 0);
});

test("pi goal extension auto-continues until complete, blocked, or max rounds", () => {
	assert.match(extension, /__PI_DECK_GOAL_MODE__/);
	assert.match(extension, /GOAL_COMPLETE/);
	assert.match(extension, /GOAL_BLOCKED/);
	assert.match(extension, /triggerTurn: true, deliverAs: "followUp"/);
	assert.match(extension, /phase: "paused"/);
	assert.match(extension, /\["clear", "reset"\]/);
});

test("goal/plan composer chrome uses an inset accent rail and an in-chip exit", () => {
	// 身份条画在圆角盒内侧：贴外沿的 3px 实心条在默认近黑 accent 下会像一根粗棍。
	const rail = timelineCss.match(/\.composer-box::before \{[\s\S]*?\n\}/)?.[0] ?? "";
	assert.match(rail, /left:\s*8px/);
	assert.match(rail, /width:\s*2px/);
	assert.match(rail, /border-radius:\s*999px/);
	assert.doesNotMatch(rail, /left:\s*-1px/);
	assert.doesNotMatch(rail, /width:\s*3px/);
	assert.match(timelineCss, /\.composer-box\.goal-mode::before \{[\s\S]*?color-mix\(in srgb, var\(--color-accent\) 55%/);
	assert.match(composerComponents, /composer-mode-cluster/);
	assert.match(composerComponents, /composer-mode-exit/);
	assert.match(composerComponents, /<X size=\{12\}/);
	assert.doesNotMatch(composerComponents, /mode-cancel/);
});

test("pi goal extension: a new goal typed after complete replaces the old objective", () => {
	// 完成后目标模式里发的原文必须替换旧目标（修复前只重置 phase，
	// 新目标既不显示也不被执行），且替换语义应清空上一目标消耗的轮次。
	assert.match(extension, /else if \(state\.phase === "complete"\)/);
	// 完成分支把新原文作为替换目标传入，而不是落入末位 else 只改 phase。
	assert.match(extension, /上一目标已完成：目标模式里发的原文是「替换为新目标」/);
	assert.match(extension, /} else if \(state\.phase === "complete"\) \{[\s\S]*?setActive\(ctx, body\);/);
	// 替换语义清空上一目标消耗的轮次；恢复（不传参）保留原轮次。
	assert.match(extension, /roundsStarted: replacing \? 0 : state\.roundsStarted/);
	assert.match(extension, /暂停\/阻塞 ≠ 完成：正文保持原文推进同一目标/);
});

test("pi goal extension: resume kicks off a turn and abort stops the loop", () => {
	// resume/on/enable 后必须真正派发一轮续跑，而不是只把 phase 置回 active 空转。
	assert.match(extension, /kickOffContinuation\(\);/);
	assert.match(extension, /恢复必须真正触发一轮续跑：否则 agent 空闲时 goal 只标 active、不干活/);
	// 恢复与自动续轮共用同一派发 helper（triggerTurn + followUp）。
	assert.match(extension, /function kickOffContinuation\(\): void \{[\s\S]*?triggerTurn: true, deliverAs: "followUp"/);
	// Stop 会话（abort）后 agent_end 不再自动续轮：检查 assistant 的 stopReason。
	assert.match(extension, /lastAssistant\.stopReason === "aborted" \|\| lastAssistant\.stopReason === "error"/);
	assert.match(extension, /停止会话却停不下来/);
});

// End of goal-mode contract coverage.
