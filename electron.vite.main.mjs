import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";

/**
 * main+preload-only 构建配置（npm run build:main）。
 *
 * 用途：dev 监听失效（本机 electron-vite dev 的 watcher 偶发不再响应 src/main
 * 变更）或只想快速验证主进程改动时，~4 秒重建 out/main + out/preload——
 * 全量 electron-vite build 的耗时几乎全在渲染层 7600+ 模块 transform。
 *
 * 约束：main/preload 段与 electron.vite.config.ts 严格同构（entry/external/
 * define 不许漂移），仅省略 renderer——不写 out/renderer，与运行中的 dev
 * server 无冲突；改完重启应用（或等 dev 重启）即生效。
 * 两份配置的 main 入口和 define 须同步维护。
 */
export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin()],
		build: {
			lib: {
				entry: resolve(__dirname, "src/main/index.ts"),
				formats: ["cjs"],
			},
		},
		define: {
			// 构建标记：npm run dist:win:dev 打包时注入 true，用于隔离 dev 构建的配置目录与 AppUserModelID。
			__PIDECK_DEV_BUILD__: JSON.stringify(process.env.PIDECK_DEV_BUILD === "1"),
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
	},
});
