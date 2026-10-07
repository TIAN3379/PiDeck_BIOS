import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

/** Execute production hook callbacks with deterministic React scheduling and deferred IPC.
 * This is a callback regression harness, not a DOM or GUI substitute.
 */
export function biosHookHarness(file, exportedName, initialProps, bios) {
	const slots = [];
	let cursor = 0;
	let dirty = true;
	let props = initialProps;
	let claim = { sessionRef: { agentId: "agent-a", sessionId: "session-a" }, runtimeGeneration: 1 };
	let output;
	let effects = [];
	const listeners = new Set();
	const equal = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
	const memo = (factory, deps) => {
		const index = cursor++;
		if (!slots[index] || !equal(slots[index].deps, deps)) slots[index] = { deps, value: factory() };
		return slots[index].value;
	};
	const react = {
		useState(initial) {
			const index = cursor++;
			if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
			return [
				slots[index].value,
				(next) => {
					slots[index].value = typeof next === "function" ? next(slots[index].value) : next;
					dirty = true;
				},
			];
		},
		useRef: (initial) => memo(() => ({ current: initial }), []),
		useMemo: memo,
		useCallback: (callback, deps) => memo(() => callback, deps),
		useEffect(effect, deps) {
			const index = cursor++;
			if (slots[index] && equal(slots[index].deps, deps)) return;
			const previous = slots[index];
			slots[index] = { deps };
			effects.push(() => {
				previous?.cleanup?.();
				slots[index].cleanup = effect();
			});
		},
	};
	const api = {
		...bios,
		onChanged(callback) {
			listeners.add(callback);
			return () => listeners.delete(callback);
		},
	};
	// D4：会话 runtime 事件订阅（会话终结 ⇒ 自动刷新宿主投影的自动记忆状态）。
	const runtimeListeners = new Set();
	const sessions = {
		onRuntimeEvent(callback) {
			runtimeListeners.add(callback);
			return () => runtimeListeners.delete(callback);
		},
	};
	const module = loadTsCommonJs(file, { stubs: { react, "../desktopApi": { desktopApi: { bios: api, sessions } }, "./useBiosSessionClaim": { useBiosSessionClaim: () => ({ claim }) }, "../i18n": { t: (key) => key } } });
	function render() {
		cursor = 0;
		dirty = false;
		output = module[exportedName](props);
		const pending = effects;
		effects = [];
		for (const effect of pending) effect();
		return output;
	}
	return {
		get current() {
			if (dirty) render();
			return output;
		},
		async flush() {
			for (let i = 0; i < 12; i++) {
				if (dirty) render();
				await Promise.resolve();
			}
		},
		setProps(next) {
			props = next;
			render();
		},
		setClaim(next) {
			claim = next;
			render();
		},
		changed(event = { kind: "settings" }) {
			for (const listener of [...listeners]) listener(event);
		},
		/** 推送一条会话 runtime 事件（D4：会话终结后默认状态自动刷新）。 */
		runtimeEvent(event) {
			for (const listener of [...runtimeListeners]) listener(event);
		},
		unmount() {
			for (const slot of slots) slot.cleanup?.();
		},
	};
}

export function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

export function businessResult(result, committed = false) {
	return { result, committed, guard: { configurationVersion: 1, stable: true, staleReason: null } };
}
