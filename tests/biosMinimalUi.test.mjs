import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { biosHookHarness, deferred } from "./helpers/biosHookHarness.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const read = (file) => readFileSync(file, "utf8");
const hookPath = "src/renderer/src/hooks/useBiosConnectionStatus.ts";
const snapshot = (desktopProjectId, authorized = true) => ({ configurationVersion: 1, revision: 1, projects: [{ projectId: `bios-${desktopProjectId}`, desktopProjectId, displayName: desktopProjectId, paths: ["C:/synthetic/project"], authorized }] });

test("minimal status resolves an existing connection without a model/runtime and refreshes revocation", async () => {
	let value = snapshot("desktop-a");
	const harness = biosHookHarness(hookPath, "useBiosConnectionStatus", { desktopProjectId: "desktop-a", ready: true }, { connections: async () => value });
	await harness.flush();
	assert.equal(harness.current.connection?.projectId, "bios-desktop-a");
	value = snapshot("desktop-a", false);
	harness.changed();
	await harness.flush();
	assert.equal(harness.current.connection, null);
	harness.unmount();
});

test("minimal status rejects a late old-project response and never guesses another project", async () => {
	const old = deferred();
	let first = true;
	const harness = biosHookHarness(hookPath, "useBiosConnectionStatus", { desktopProjectId: "desktop-a", ready: true }, { connections: () => (first ? ((first = false), old.promise) : Promise.resolve(snapshot("desktop-b"))) });
	void harness.current;
	harness.setProps({ desktopProjectId: "desktop-b", ready: true });
	await harness.flush();
	old.resolve(snapshot("desktop-a"));
	await harness.flush();
	assert.equal(harness.current.connection?.projectId, "bios-desktop-b");
	harness.setProps({ desktopProjectId: undefined, ready: true });
	await harness.flush();
	assert.equal(harness.current.connection, null, "ordinary chat has no engineering identity");
	harness.unmount();
});

test("minimal status reports unreadable/ambiguous records instead of claiming connected", async () => {
	let fail = true;
	const duplicate = snapshot("desktop-a");
	duplicate.projects.push({ ...duplicate.projects[0], projectId: "other" });
	const harness = biosHookHarness(
		hookPath,
		"useBiosConnectionStatus",
		{ desktopProjectId: "desktop-a", ready: true },
		{
			connections: async () => {
				if (fail) throw new Error("unreadable");
				return duplicate;
			},
		},
	);
	await harness.flush();
	assert.equal(harness.current.connection, null);
	assert.match(harness.current.problem, /unreadable/);
	fail = false;
	harness.changed();
	await harness.flush();
	assert.equal(harness.current.connection, null);
	assert.equal(harness.current.conflict, true);
	harness.unmount();
});

test("onboarding has one root owner, not separate forms in the drawer or advanced manager", () => {
	const app = read("src/renderer/src/App.tsx");
	assert.equal((app.match(/<BiosFirstRunGate\b/g) ?? []).length, 1);
	assert.doesNotMatch(app.match(/<BiosFirstRunGate[^>]+>/)?.[0] ?? "", /suppressed=/);
	for (const file of ["BiosWorkbenchPanel.tsx", "BiosWorkflowOverview.tsx", "BiosProjectSection.tsx"]) {
		assert.doesNotMatch(read(`src/renderer/src/components/bios/${file}`), /<BiosFirstRunGate|<BiosProjectOnboarding/);
	}
	assert.match(read("src/renderer/src/components/bios/BiosFirstRunGate.tsx"), /<DialogContent/);
});

test("temporary history analysis survives closing the management window to send its prepared prompt", () => {
	const panel = read("src/renderer/src/components/bios/BiosWorkbenchPanel.tsx");
	assert.equal((panel.match(/const history = useBiosHistoryWorkflow\(/g) ?? []).length, 1);
	assert.ok(panel.indexOf("useBiosHistoryWorkflow({") < panel.indexOf("<Dialog"));
	const pane = read("src/renderer/src/components/bios/knowledge/BiosHistoryPane.tsx");
	assert.match(pane, /props\.workflow/);
	assert.doesNotMatch(pane, /useBiosHistory\(|useEffect\(/);
	const owner = read("src/renderer/src/hooks/useBiosHistoryWorkflow.ts");
	assert.match(owner, /history\.revision/);
	assert.match(owner, /onChanged\(retractDraft\)/);
	assert.match(owner, /sourceMismatch/);
	assert.match(owner, /historyEvidence\(\{ token: evidence\.token, sha: evidence\.commit\.sha \}\)/);
	const section = read("src/renderer/src/components/bios/BiosKnowledgeSection.tsx");
	assert.match(section, /const dirty = props\.dirty/);
	assert.match(section, /const setDirty = props\.onDirtyChange/);
	assert.match(panel, /dirty=\{knowledgeDirty\}/);
});

test("BIOS approval modal cancels explicitly, disables busy actions and cannot appear for a background session", () => {
	let cancelled = 0;
	let confirmed = 0;
	const jsx = (type, props) => ({ type, props });
	const { BiosRuntimeConfirm } = loadTsCommonJs("src/renderer/src/components/bios/BiosRuntimeConfirm.tsx", {
		stubs: {
			jotai: { useAtomValue: () => "focused" },
			"../../atoms/session-atoms": { currentSessionIdAtom: "current" },
			"../../i18n": { t: (key) => key },
			"react/jsx-runtime": { jsx, jsxs: jsx },
			"../ui-shadcn/button": { Button: "Button" },
			"../ui-shadcn/dialog": { Dialog: "Dialog", DialogContent: "DialogContent", DialogTitle: "DialogTitle" },
		},
	});
	const props = { sessionId: "focused", request: { title: "确认 BIOS 关键操作", message: "Synthetic scope", method: "confirm" }, responding: false, onConfirm: () => confirmed++, onCancel: () => cancelled++ };
	assert.equal(BiosRuntimeConfirm({ ...props, sessionId: "background" }), null);
	const modal = BiosRuntimeConfirm(props);
	modal.props.onOpenChange(false);
	assert.equal(cancelled, 1);
	assert.equal(confirmed, 0, "closing never grants approval");
	const content = modal.props.children;
	const buttons = content.props.children[2].props.children;
	buttons[1].props.onClick();
	assert.equal(confirmed, 1, "only the explicit confirm action approves");
	const busy = BiosRuntimeConfirm({ ...props, responding: true });
	busy.props.onOpenChange(false);
	assert.equal(cancelled, 1, "an in-flight response is not sent twice");
	assert.equal(busy.props.children.props.showCloseButton, false);
	assert.ok(busy.props.children.props.children[2].props.children.every((button) => button.props.disabled));
});
