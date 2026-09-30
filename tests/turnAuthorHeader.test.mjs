import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const turnRow = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");
const header = readFileSync("src/renderer/src/components/session/turn/TurnAuthorHeader.tsx", "utf8");
const backendMark = readFileSync("src/renderer/src/components/session/SessionSourceBadge.tsx", "utf8");

test("TurnRow always mounts a Pi/ImageGen author header, not backend-only text", () => {
	assert.match(turnRow, /<TurnAuthorHeader backend=\{props\.backend\} endedAt=\{run\.endedAt\} \/>/);
	// 旧策略：Pi 默认不署名、只给非默认后端短标签。时间线行头已改回两边都用 logo/图标。
	assert.doesNotMatch(turnRow, /props\.backend === "[a-z]+" &&/);
	assert.doesNotMatch(turnRow, /sessionBackend\.dsh/);
});

test("TurnAuthorHeader uses shadcn Avatar icons without a visible name", () => {
	assert.match(header, /from "\.\.\/\.\.\/ui-shadcn\/avatar"/);
	assert.match(header, /<Avatar title=\{name\}/);
	assert.match(header, /<AvatarFallback/);
	assert.match(header, /<PiLogo/);
	assert.match(header, /<ImageIcon/);
	assert.match(header, /data-turn-author=\{backend\}/);
	// 缺省按 pi 处理，兼容旧调用方不传 backend
	assert.match(header, /props\.backend \?\? "pi"/);
	// 名称只给读屏/悬停，不再跟在 logo 旁边当可见署名
	assert.match(header, /aria-label=\{name\}/);
	assert.match(header, /sessionBackend\.pi/);
	assert.match(header, /sessionBackend\.imagegen/);
	assert.doesNotMatch(header, /sessionBackend\.dsh/);
	assert.doesNotMatch(header, /DshLogo/);
	assert.doesNotMatch(header, /<span[^>]*>\{\s*name\s*\}<\/span>/);
});

test("sidebar SessionBackendMark still hides Pi to avoid list noise", () => {
	// 侧栏/Tab 降噪策略保持不变：只有非默认后端（imagegen）才打标。
	assert.match(backendMark, /if \(props\.backend === "imagegen"\)/);
	assert.match(backendMark, /<SessionBackendBadge backend=\{props\.backend\}/);
	assert.match(backendMark, /return null;/);
	assert.doesNotMatch(backendMark, /DshLogo|AgentPresetLogo/);
});
