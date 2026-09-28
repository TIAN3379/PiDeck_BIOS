import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

function load({ present = true, reduced = false } = {}) {
	const host = quickMessageHookHost();
	const api = createTsSandbox({
		stubs: {
			react: { ...host.react, createContext: () => ({ Provider: "provider" }), forwardRef: (render) => render, useContext: () => 7, useId: () => "sidebar", useLayoutEffect: host.react.useEffect },
			"react/jsx-runtime": { jsx: (type, props) => ({ type, props }) },
			"motion/react": { motion: { div: "motion-div" }, useIsPresent: () => present, useReducedMotion: () => reduced, AnimatePresence: "presence", LayoutGroup: "layout-group" },
			"../../lib/utils": { cn: (...args) => args.filter(Boolean).join(" ") },
		},
	})("src/renderer/src/components/sidebar/SidebarRemovalRow.tsx");
	return { ...api, host };
}

function renderRow(options) {
	return load(options).SidebarRemovalRow({ itemId: "row-a", children: "content" }).props;
}

test("real deletion fades briefly and shifts sibling positions without squeezing row height", () => {
	const row = renderRow();
	const exit = row.variants.removed([]);
	assert.equal(exit.opacity, 0);
	assert.equal(exit.transition.duration, 0.1);
	assert.equal(exit.height, undefined);
	assert.equal(exit.marginTop, undefined);
	assert.equal(row.layout, "position");
	assert.equal(row.layoutDependency, 7);
	assert.equal(row.transition.layout.duration, 0.16);
	assert.equal(row.initial, false);
});

test("search filtering or source filtering is not treated as a deleted record", () => {
	assert.equal(renderRow().variants.removed(["row-a"]).transition.duration, 0);
});

test("reduced motion skips both fade and sibling movement", () => {
	const row = renderRow({ reduced: true });
	assert.equal(row.variants.removed([]).transition.duration, 0);
	assert.equal(row.transition.layout.duration, 0);
});

test("retained exiting rows are inert and hidden from assistive navigation", () => {
	const row = renderRow({ present: false });
	assert.equal(row.inert, true);
	assert.equal(row["aria-hidden"], true);
	assert.match(row.className, /pointer-events-none/);
});

test("layout measurements are keyed only by real record removals, not ordinary rerenders or additions", () => {
	const { host, SidebarRemovalList } = load();
	const generation = (ids) => host.render(() => SidebarRemovalList({ remainingIds: ids, children: "rows" })).props.value;
	assert.equal(generation(["a", "b"]), 0);
	assert.equal(generation(["a", "b"]), 0);
	assert.equal(generation(["b", "a"]), 0);
	assert.equal(generation(["b", "a", "c"]), 0);
	assert.equal(generation(["a", "c"]), 1);
	assert.equal(generation(["a", "c"]), 1);
	assert.equal(generation(["c"]), 2);
});
