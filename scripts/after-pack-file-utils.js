/** Shared filesystem primitives for afterPack cleanup domains. */
const fs = require("node:fs");
const path = require("node:path");

/** Recursively remove a directory. */
async function rmDir(dir) {
	try {
		await fs.promises.rm(dir, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

/** Return a directory's file size without failing the packaging cleanup on unreadable entries. */
async function dirSize(dir) {
	let total = 0;
	try {
		const entries = await fs.promises.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				total += await dirSize(full);
			} else if (entry.isFile()) {
				total += (await fs.promises.stat(full)).size;
			}
		}
	} catch {
		/* Ignore unreadable cleanup candidates. */
	}
	return total;
}

module.exports = { dirSize, rmDir };
