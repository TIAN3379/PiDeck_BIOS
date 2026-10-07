import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { BUILT_IN_EXTENSIONS_OVERLAY_DIR_NAME, readVerifiedArtifact, type BuiltInExtensionsManifest } from "./builtInExtensionsManifest";

/**
 * PiDeck 内置扩展（随应用 resources 分发，不再复制到 ~/.pi/agent/extensions）。
 * 启动 RPC 时通过可重复的 `--extension/-e` 注入，避免污染用户全局 pi。
 *
 * ⚠️ **只列「入口」扩展文件**：被扩展 import 的辅助模块（如 `pi-deck-todo-state.ts`、
 * `pi-deck-gui-bridge-*.ts`）**不在**本表 —— 它们不通过 `-e` 注入，
 * 但仍必须进 `extensions-manifest.json`（清单按目录扫描全部 `.ts`），
 * 否则热更新覆盖层会缺少依赖、pi 报模块找不到。
 *
 * ⚠️ 顺序有语义：`pi-deck-gui-bridge` 排在**最前**。
 * 它负责在 `session_start` 里包装共享的 `ctx.ui`，把 RPC 下被丢弃的声明式
 * UI 扩展点接回 PiDeck。pi 按 `-e` 顺序加载扩展，桥先加载使**内置批次内部**
 * 时序无歧义。
 *
 * ⚠️ 但这只管内置批次自己：pi 的发现顺序是「项目 → 全局 `~/.pi/agent/extensions`
 * → `-e` 显式」，全局用户扩展**永远先于**本批次加载/注册，同一次 emit
 * 的 handler 按注册顺序共享同一个 ctx 执行——所以全局扩展在 `session_start`
 * 里拿不到 `ctx.gui`，**不能靠调整这里的顺序解决**。
 * 桥的解法是把 `gui` getter 同时挂上 `ctx.ui` **共享单例**（`ui.gui`）：
 * 任何加载顺序的扩展，从桥挂载后的任何事件 / 命令 handler 里
 * `ctx.ui.gui` 都可靠可用（见桥 `docs/extension-points.md` §2.1）。
 *
 * `pi-deck-ext-points`（扩展点面板）紧随其后：它要用桥挂出来的 `ctx.gui`。
 */
export const BUILT_IN_EXTENSIONS = [
	"pi-deck-gui-bridge.ts",
	"pi-deck-ext-points.ts",
	"pi-deck-request-size-recovery.ts",
	"pi-deck-ask-question.ts",
	"pi-deck-goal-mode.ts",
	"pi-deck-nul-redirect-fix.ts",
	"pi-deck-plan-mode.ts",
	"pi-deck-retry-no-body.ts",
	"pi-deck-security-gate.ts",
	"pi-deck-session-title.ts",
	"pi-deck-subagents.ts",
	"pi-deck-todo.ts",
	"pi-deck-trash-guard.ts",
	"pi-deck-vision.ts",
] as const;

/** Internal adapter loaded after user-facing tool policies; not listed in settings UI. */
export const INTERNAL_BUILT_IN_EXTENSIONS = ["pi-deck-shell-proxy.ts"] as const;

/**
 * BM-07A C3：**BIOS 专业 Package** 的源标识（禁用链/设置里的 source 名）。
 *
 * 与普通内置扩展不同：它是**一个目录**（含 `extensions/` + `core/` + `skills/` 的整包），
 * 以 `-e <包目录>` 注入——pi 会用包内的 `pi.skills` 清单一起加载 Skills。
 * 只复制入口 TS 会让 `../core/**` 的相对 import 解析失败，所以**整包**随应用分发。
 */
export const BIOS_AGENT_PACKAGE_SOURCE = "bios-agent";
const ALL_BUILT_IN_EXTENSIONS = [...BUILT_IN_EXTENSIONS, ...INTERNAL_BUILT_IN_EXTENSIONS] as const;

export type BuiltInExtensionName = (typeof BUILT_IN_EXTENSIONS | typeof INTERNAL_BUILT_IN_EXTENSIONS)[number];

export type BuiltInExtensionPathRoots = {
	/** 开发态 app 根（含 resources/extensions） */
	appPath: string;
	/** 打包态 process.resourcesPath（extraResources 的 extensions/） */
	resourcesPath: string;
	isDev: boolean;
	/**
	 * 覆盖层目录（`<userData>/builtin-extensions`，内置扩展热更新的落点）。
	 * 目录内存在同名文件时优先返回它，`-e` 注入路径随之指向覆盖层，重启会话即生效。
	 * 缺省（测试/探针）表示不使用覆盖层，行为与引入热更新前一致。
	 */
	overlayDir?: string;
};

/** 校验 source 是否为允许的内置扩展 basename（防路径穿越；含专业 Package 目录名）。 */
export function isBuiltInExtensionName(source: string): source is BuiltInExtensionName | typeof BIOS_AGENT_PACKAGE_SOURCE {
	const name = basename(source.trim());
	if (name !== source.trim()) return false;
	if (name === BIOS_AGENT_PACKAGE_SOURCE) return true;
	return (ALL_BUILT_IN_EXTENSIONS as readonly string[]).includes(name);
}

/** 兼容旧 BIOS toggle 的误写：在用户恢复前，两种启动模式都尊重其禁用意图。 */
export function effectiveRemovedBuiltInExtensions(removed: readonly string[], disabled: readonly { scope: string; source: string }[]): string[] {
	return [...new Set([...removed, ...disabled.filter((entry) => entry.scope === "user" && entry.source.trim() === BIOS_AGENT_PACKAGE_SOURCE).map(() => BIOS_AGENT_PACKAGE_SOURCE)])];
}

/**
 * 专业 Package 目录：开发态 = 仓库 `packages/bios-agent`；打包态 = `resources/bios-agent`
 * （见根 `package.json` 的 `extraResources`）。
 */
export function resolveBiosAgentPackageDir(roots: BuiltInExtensionPathRoots): string {
	return roots.isDev ? join(roots.appPath, "packages", "bios-agent") : join(roots.resourcesPath, BIOS_AGENT_PACKAGE_SOURCE);
}

/** 专业 Package 的扩展入口（存在才算这个包可用；注入的路径是**包目录**而不是入口文件）。 */
export function resolveBiosAgentPackageEntry(roots: BuiltInExtensionPathRoots): string {
	return join(resolveBiosAgentPackageDir(roots), "extensions", "index.ts");
}

/** 专业 Package 的可显示信息（版本 / Skills 数量 / 是否可用）。 */
export type BiosAgentPackageInfo = {
	readonly dir: string;
	readonly entry: string;
	readonly version: string | null;
	/** `skills/` 下的技能目录数（`pi.skills` 清单指向它）。 */
	readonly skillCount: number;
};

/**
 * R36-3：读专业包的**实际磁盘信息**，供扩展管理界面显示来源/目录/版本/Skills。
 *
 * 只读 `package.json` 与 `skills/` 目录清单，不做任何写入；包不可用时返回 null（界面按"缺失"显示）。
 */
export function readBiosAgentPackageInfo(roots: BuiltInExtensionPathRoots): BiosAgentPackageInfo | null {
	const dir = resolveBiosAgentPackageDir(roots);
	const entry = resolveBiosAgentPackageEntry(roots);
	if (!existsSync(entry)) return null;
	let version: string | null = null;
	let skillCount = 0;
	try {
		const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown };
		version = typeof manifest.version === "string" && manifest.version !== "" ? manifest.version : null;
	} catch {
		version = null;
	}
	try {
		skillCount = readdirSync(join(dir, "skills"), { withFileTypes: true }).filter((item) => item.isDirectory()).length;
	} catch {
		skillCount = 0;
	}
	return { dir, entry, version, skillCount };
}

/**
 * 覆盖层目录：`<userData>/builtin-extensions`。
 * 传 userData 而不是直接读 electron，保持纯函数、可被 node --test 直接加载。
 */
export function resolveBuiltInExtensionsOverlayDir(userDataDir: string): string {
	return join(userDataDir, BUILT_IN_EXTENSIONS_OVERLAY_DIR_NAME);
}

/**
 * 覆盖层可用性缓存（单个目录，进程内）。
 *
 * 覆盖层是**完整快照**：扩展之间存在相对 import（pi-deck-todo.ts → ./pi-deck-todo-state.ts），
 * 只判断「同名文件存在」不够——缺一个文件就会让 pi 解析不到依赖。因此必须整份校验
 * （清单可解析 + 每个声明的文件 bytes/sha256 吻合），校验不过一律当没有覆盖层。
 *
 * 校验要读全部十几个文件，而路径解析会对每个扩展名各调一次，故按目录缓存结果；
 * 热更新器写完/还原覆盖层后调用 invalidate 失效。
 */
let overlayArtifactCache: { dir: string; manifest: BuiltInExtensionsManifest | null } | null = null;

/** 供热更新器在写盘/还原后调用，让下一次路径解析重新校验。 */
export function invalidateBuiltInExtensionsOverlayCache(): void {
	overlayArtifactCache = null;
}

/** 覆盖层的有效清单（校验通过才有值；结果按目录缓存）。 */
function overlayArtifact(overlayDir: string): BuiltInExtensionsManifest | null {
	if (overlayArtifactCache?.dir === overlayDir) return overlayArtifactCache.manifest;
	const manifest = readVerifiedArtifact(overlayDir);
	overlayArtifactCache = { dir: overlayDir, manifest };
	return manifest;
}

/**
 * 当前生效的内置扩展包版本（覆盖层优先，否则随包内置）。
 * 版本号由 resources/extensions/extensions-manifest.json 维护，**不跟 PiDeck 应用版本走**。
 * 清单缺失（旧安装包）返回 null，此时扩展列表版本列回退「-」。
 */
export function readEffectiveBuiltInExtensionsVersion(roots: BuiltInExtensionPathRoots): string | null {
	if (roots.overlayDir) {
		const overlay = overlayArtifact(roots.overlayDir);
		if (overlay) return overlay.version;
	}
	return readVerifiedArtifact(resolveBuiltInExtensionsDir(roots))?.version ?? null;
}

/** 内置扩展目录绝对路径（不含文件名）——覆盖层比对与热更新读取内置清单时使用。 */
export function resolveBuiltInExtensionsDir(roots: BuiltInExtensionPathRoots): string {
	return roots.isDev ? join(roots.appPath, "resources", "extensions") : join(roots.resourcesPath, "extensions");
}

/**
 * 扩展运行时依赖的 vendored node_modules 源目录（供覆盖层复制，见 builtInExtensionsUpdater）。
 *
 * 打包态：extraResources 把 `node_modules/<pkg>` 复制到 `extensions/node_modules/<pkg>`；
 * 开发态：直接用仓库顶层 node_modules（extensionPackagingDeps.test.mjs 保证它有这些包）。
 */
export function resolveVendorNodeModulesDir(roots: BuiltInExtensionPathRoots): string {
	return roots.isDev ? join(roots.appPath, "node_modules") : join(roots.resourcesPath, "extensions", "node_modules");
}

/**
 * 解析单个内置扩展在本机磁盘上的绝对路径。
 * 覆盖层（热更新）优先 → 开发态 appPath/resources/extensions → 打包态 resourcesPath/extensions。
 */
export function resolveBuiltInExtensionPath(extensionName: string, roots: BuiltInExtensionPathRoots): string {
	const name = basename(extensionName.trim());
	if (!isBuiltInExtensionName(name)) {
		throw new Error(`非法内置扩展名: ${extensionName}`);
	}
	// 专业 Package 是**目录**：不做覆盖层比对（它不参与热更新覆盖），直接给包目录。
	if (name === BIOS_AGENT_PACKAGE_SOURCE) return resolveBiosAgentPackageDir(roots);
	// 覆盖层优先：热更新写入的版本必须真正参与 -e 注入，否则「更新成功」只是自欺。
	// 但要整份校验通过才认——半截覆盖层（缺文件/被外部改动）会让 pi 解析不到相对 import。
	if (roots.overlayDir && overlayArtifact(roots.overlayDir)) {
		const overlayPath = join(roots.overlayDir, name);
		// 老版本覆盖层可能没有后来新增的内部适配器；回落到随包文件，
		// 不让一个仍然有效的旧快照把新版本的代理隔离保护静默关掉。
		if (existsSync(overlayPath)) return overlayPath;
	}
	return join(resolveBuiltInExtensionsDir(roots), name);
}

/**
 * 返回当前应注入到 pi RPC 的内置扩展绝对路径列表。
 * - removedBuiltInExtensions 中的用户扩展跳过；内部适配器始终保留
 * - 源文件缺失的跳过（打日志由调用方处理）
 * - piRpcNoExtensions 由调用方决定是否整段跳过
 */
export function listActiveBuiltInExtensionPaths(roots: BuiltInExtensionPathRoots, removedBuiltInExtensions: readonly string[] = []): string[] {
	const removed = new Set(removedBuiltInExtensions.map((item) => basename(item.trim())).filter(Boolean));
	const paths: string[] = [];
	for (const name of ALL_BUILT_IN_EXTENSIONS) {
		if (name !== "pi-deck-shell-proxy.ts" && removed.has(name)) continue;
		const fullPath = resolveBuiltInExtensionPath(name, roots);
		if (!existsSync(fullPath)) continue;
		paths.push(fullPath);
	}
	// BM-07A C3：**专业 Package** 以整包目录参与同一条白名单/禁用链。
	// - 入口存在（`extensions/index.ts`）才注入整包：只复制入口 TS 的分发会让相对 import 解析失败；
	// - 用户在设置里移除 `bios-agent` ⇒ 不注入 ⇒ 回到普通 Pi（知识库与配置都不删除）。
	if (!removed.has(BIOS_AGENT_PACKAGE_SOURCE) && existsSync(resolveBiosAgentPackageEntry(roots))) {
		paths.push(resolveBiosAgentPackageDir(roots));
	}
	return paths;
}

/**
 * 把内置扩展路径追加为可重复的 `--extension <path>`。
 * pi 文档：`--no-extensions` 只关自动发现，显式 -e 仍有效；
 * 但 PiDeck 约定 piRpcNoExtensions 时连内置也不注入（诊断干净）。
 */
export function appendBuiltInExtensionArgs(args: readonly string[], extensionPaths: readonly string[], options: { noExtensions?: boolean } = {}): string[] {
	if (options.noExtensions || extensionPaths.length === 0) return [...args];
	const next = [...args];
	for (const extensionPath of extensionPaths) {
		const trimmed = extensionPath.trim();
		if (!trimmed) continue;
		next.push("--extension", trimmed);
	}
	return next;
}
