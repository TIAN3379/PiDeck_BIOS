/**
 * node-pty-specific afterPack cleanup and artifact verification.
 *
 * Top-level node-pty@1.1.0 does not ship Linux prebuilds. Linux npm installs
 * therefore create build/Release/pty.node, which is the package's only runtime
 * native addon. This module keeps the fallback intact and validates the final
 * asar-to-disk mapping before an installer can be produced.
 */
const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");
const { dirSize, rmDir } = require("./after-pack-file-utils");

const NODE_PTY_RELATIVE_ROOT = "node_modules/node-pty";
const NODE_PTY_PRUNABLE_DIRECTORIES = ["src", "third_party", "deps", "scripts"];

function isNonEmptyFile(filePath) {
	try {
		const stat = fs.statSync(filePath);
		return stat.isFile() && stat.size > 0;
	} catch {
		return false;
	}
}

function nodePtyHasTargetPrebuild(nodePtyDir, targetPlatform) {
	return isNonEmptyFile(path.join(nodePtyDir, "prebuilds", targetPlatform, "pty.node"));
}

/** Clean source-only node-pty directories without deleting a source-built runtime fallback. */
async function cleanNodePtyCompileTimeDirectories(nodePtyDir, targetPlatform, location) {
	if (!fs.existsSync(nodePtyDir)) return 0;

	const hasTargetPrebuild = nodePtyHasTargetPrebuild(nodePtyDir, targetPlatform);
	const directories = hasTargetPrebuild ? [...NODE_PTY_PRUNABLE_DIRECTORIES, "build"] : NODE_PTY_PRUNABLE_DIRECTORIES;
	const locationPrefix = location ? `${location} ` : "";
	let removedBytes = 0;

	for (const directory of directories) {
		const directoryPath = path.join(nodePtyDir, directory);
		if (!fs.existsSync(directoryPath)) continue;
		const size = await dirSize(directoryPath);
		await rmDir(directoryPath);
		removedBytes += size;
		console.log(`  [afterPack] ${locationPrefix}已删除 node-pty ${directory}/ (${(size / 1024 / 1024).toFixed(1)} MB)`);
	}

	const releaseNodePath = path.join(nodePtyDir, "build", "Release", "pty.node");
	if (!hasTargetPrebuild && isNonEmptyFile(releaseNodePath)) {
		// node-gyp layouts vary by version. Keeping the entire fallback tree is safer than pruning it heuristically.
		console.log(`[afterPack] ${locationPrefix}保留 node-pty build/：${targetPlatform} 缺少 prebuild，运行时回退 build/Release`);
	}

	return removedBytes;
}

function asarHeaderNodeForPath(header, relativePath) {
	let node = header;
	for (const segment of relativePath.replaceAll("\\", "/").replace(/^\/+/, "").split("/")) {
		if (!segment) continue;
		node = node?.files?.[segment];
		if (!node) return undefined;
	}
	return node;
}

function nodePtyRuntimeRelativePaths(targetPlatform) {
	return [`${NODE_PTY_RELATIVE_ROOT}/build/Release/pty.node`, `${NODE_PTY_RELATIVE_ROOT}/build/Debug/pty.node`, `${NODE_PTY_RELATIVE_ROOT}/prebuilds/${targetPlatform}/pty.node`];
}

function unpackedPathForAsarFile(asarPath, relativePath) {
	return path.join(path.dirname(asarPath), `${path.basename(asarPath)}.unpacked`, ...relativePath.split("/"));
}

/**
 * Fail closed when Electron cannot resolve node-pty's native addon from the
 * packaged app. Electron requires both the asar unpacked marker and the real
 * app.asar.unpacked file; either omission crashes the main process at startup.
 */
function assertNodePtyRuntimeArtifact(asarPath, targetPlatform) {
	const header = asar.getRawHeader(asarPath).header;
	if (!asarHeaderNodeForPath(header, NODE_PTY_RELATIVE_ROOT)) {
		throw new Error("[afterPack] node-pty package missing from app.asar; terminal startup would crash");
	}

	const candidates = nodePtyRuntimeRelativePaths(targetPlatform);
	for (const relativePath of candidates) {
		const headerNode = asarHeaderNodeForPath(header, relativePath);
		const unpackedPath = unpackedPathForAsarFile(asarPath, relativePath);
		if (headerNode?.unpacked === true && isNonEmptyFile(unpackedPath)) {
			return { relativePath, unpackedPath };
		}
	}

	const details = candidates
		.map((relativePath) => {
			const headerNode = asarHeaderNodeForPath(header, relativePath);
			const unpackedPath = unpackedPathForAsarFile(asarPath, relativePath);
			return `${relativePath} (unpacked=${headerNode?.unpacked === true}, file=${isNonEmptyFile(unpackedPath)})`;
		})
		.join(", ");
	throw new Error(`[afterPack] node-pty runtime artifact missing for ${targetPlatform}: ${details}`);
}

module.exports = {
	assertNodePtyRuntimeArtifact,
	cleanNodePtyCompileTimeDirectories,
};
