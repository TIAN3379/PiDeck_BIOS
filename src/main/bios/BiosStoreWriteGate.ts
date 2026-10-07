import { resolve } from "node:path";

/** In-process exclusion only. External CLI writers still require explicit offline confirmation. */
export class BiosStoreWriteGate {
	private readonly writers = new Map<string, number>();
	private readonly exports = new Set<string>();

	private key(root: string): string {
		const path = resolve(root);
		return process.platform === "win32" ? path.toLowerCase() : path;
	}

	async write<T>(root: string, action: () => Promise<T>): Promise<T> {
		const key = this.key(root);
		if (this.exports.has(key)) throw new Error("知识库正在离线备份：本应用写入口暂时暂停，请备份结束后重试");
		this.writers.set(key, (this.writers.get(key) ?? 0) + 1);
		try {
			return await action();
		} finally {
			const remaining = (this.writers.get(key) ?? 1) - 1;
			if (remaining === 0) this.writers.delete(key);
			else this.writers.set(key, remaining);
		}
	}

	async export<T>(root: string, action: () => Promise<T>): Promise<T> {
		const key = this.key(root);
		if (this.exports.has(key) || (this.writers.get(key) ?? 0) > 0) throw new Error("知识库仍有本应用写入或备份未结束：请等待完成后再导出");
		this.exports.add(key);
		try {
			return await action();
		} finally {
			this.exports.delete(key);
		}
	}
}
