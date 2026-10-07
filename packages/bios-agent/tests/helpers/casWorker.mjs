/**
 * R31-4 并发竞争用的**真实子进程**工作器（不是同进程 Promise 竞争）。
 *
 * 用法：
 *   node casWorker.mjs task     <root> <projectId> <taskId> <expectedRevision> <todoText>
 *   node casWorker.mjs manifest <root> <projectId> <manifestId> <expectedRevision>
 *
 * stdout 只输出**一个** JSON 对象（`{ kind, status, revision }` 或 `{ kind, error }`），
 * 让测试可以等两个子进程都结束后比较"一成一败"与胜者磁盘事实。
 */
import { readRecord, updateRecord } from "../../core/storage/index.ts";
import { updateTask } from "../../core/tasks/index.ts";

const [kind, root, projectId, id, expectedRevision, extra] = process.argv.slice(2);
const expected = Number(expectedRevision);

try {
	if (kind === "task") {
		const result = await updateTask({ root, projectId, taskId: id, expectedRevision: expected, changes: { todos: [extra ?? "worker"] }, authorizedProjectIds: [projectId], now: Date.now() });
		process.stdout.write(`${JSON.stringify({ kind, status: result.status, revision: result.revision })}\n`);
	} else if (kind === "manifest") {
		const read = await readRecord({ root, kind: "context-manifest", id, projectId });
		const result = await updateRecord({
			kind: "context-manifest",
			id,
			projectId,
			expectedRevision: expected,
			root,
			now: Date.now(),
			data: {
				...(read.record.taskId === undefined ? {} : { taskId: read.record.taskId }),
				profileRevision: read.record.profileRevision,
				sources: read.record.sources,
				expiredSources: read.record.expiredSources,
				budget: { ...read.record.budget, usedChars: (read.record.budget.usedChars ?? 0) + 1 },
				generatedAt: read.record.generatedAt + 1,
			},
		});
		process.stdout.write(`${JSON.stringify({ kind, status: "updated", revision: result.revision })}\n`);
	} else {
		process.stdout.write(`${JSON.stringify({ kind, error: `unknown kind ${kind}` })}\n`);
	}
} catch (error) {
	const code = error !== null && typeof error === "object" && "code" in error ? error.code : "error";
	process.stdout.write(`${JSON.stringify({ kind, status: code, error: error instanceof Error ? error.message : String(error) })}\n`);
}
