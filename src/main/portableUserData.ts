import { join } from "node:path";

/**
 * 历史正式包 userData 目录名（现仅作迁移旧根解析）。
 * 自数据目录更名后，正式版新根为 PiDeck（见 projects/userDataNameMigration.ts），
 * 首启由迁移器把旧根整体改名过去；这里保留旧值供迁移器引用，避免两名各写一份。
 */
export const PACKAGED_USER_DATA_NAME = "pi-desktop";

/** 正式包 userData 新目录名（与 productName 一致）。 */
export const PACKAGED_USER_DATA_NAME_NEW = "PiDeck";

/** 便携版把数据放在 exe 同级 data/，与安装版隔离。 */
export const PORTABLE_USER_DATA_DIR_NAME = "data";

export type PackagedUserDataInput = {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	appData: string;
};

/**
 * 解析正式包装后的 userData。
 * Windows 便携 exe 由 electron-builder 注入 PORTABLE_EXECUTABLE_DIR；
 * 若仍落到安装版同一目录，同版本单实例锁会让第二次启动静默退出（表现为「点了没反应」）。
 * 安装版落 PiDeck（旧 pi-desktop 根由 userDataNameMigration 首启整体改名接管）。
 */
export function resolvePackagedUserDataDir(input: PackagedUserDataInput): string {
	const platform = input.platform ?? process.platform;
	const env = input.env ?? process.env;
	const portableDir = env.PORTABLE_EXECUTABLE_DIR?.trim();
	if (platform === "win32" && portableDir) {
		return join(portableDir, PORTABLE_USER_DATA_DIR_NAME);
	}
	return join(input.appData, PACKAGED_USER_DATA_NAME_NEW);
}

/** 便携版判定与 resolvePackagedUserDataDir 同一准则：迁移器据此跳过改名。 */
export function isPortablePackagedEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
	return platform === "win32" && Boolean(env.PORTABLE_EXECUTABLE_DIR?.trim());
}
