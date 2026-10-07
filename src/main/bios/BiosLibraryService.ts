/** Local human library: browse trusted storage without exposing this API to the model.
 * Reads use storage path/schema/symlink guards; writes reuse CAS, journal and review rules.
 * Inspecting retained/unapproved knowledge here never changes AI authorization settings.
 */
import { createHash } from "node:crypto";
import { createStorageBoundary, readRecord, readRegistry } from "../../../packages/bios-agent/core/storage/index.ts";
import { updateExperienceDraft, updateFeature, reviewExperience } from "../../../packages/bios-agent/core/knowledge/index.ts";
import type { BiosHostSettings } from "../../shared/types/bios";
import type { BiosLibraryDetail, BiosLibraryEntry, BiosLibraryListRequest, BiosLibraryPage, BiosLibraryReceipt, BiosLibraryRef, BiosLibraryReview, BiosLibraryUpdate } from "../../shared/types/biosLibrary";
import { normalizeBiosHostSettings } from "./biosProcessEnv.ts";
import { BiosStoreWriteGate } from "./BiosStoreWriteGate.ts";

export class BiosLibraryService {
	private readonly options: { readSettings: () => Partial<BiosHostSettings> | null; readConfigurationVersion: () => number; writeGate?: BiosStoreWriteGate };
	constructor(options: BiosLibraryService["options"]) {
		this.options = options;
	}
	private readonly fallbackGate = new BiosStoreWriteGate();
	private current(key?: string): { root: string; key: string } {
		const root = normalizeBiosHostSettings(this.options.readSettings() ?? undefined).knowledgeRoot;
		if (root === null) throw new Error("尚未配置知识库，请先选择本地知识库目录");
		const current = createHash("sha256")
			.update(JSON.stringify([root, this.options.readConfigurationVersion()]))
			.digest("hex");
		if (key !== undefined && current !== key) throw new Error("知识库配置已变化，请刷新列表后重新打开记录；未写入");
		return { root, key: current };
	}

	/** Bounded pages: at most 5,000 directory names and 40 record bodies per request. */
	async list(request: BiosLibraryListRequest): Promise<BiosLibraryPage> {
		const context = this.current(request.libraryKey);
		const registry = await readRegistry({ root: context.root });
		const boundary = await createStorageBoundary({ root: context.root });
		const listing = await boundary.listEntries(boundary.resolve(request.kind === "experience-card" ? "experiences" : "features"), { filesOnly: true, includeSymlinks: true, maxEntries: 5_000 });
		const names = listing.names.filter((name) => !name.startsWith(".") && name.endsWith(".json")).sort();
		const candidates = names.filter((name) => request.after === undefined || name.slice(0, -5) > request.after);
		const entries: BiosLibraryEntry[] = [];
		const problems: string[] = [];
		const query = request.query?.trim().toLocaleLowerCase() ?? "";
		let next: string | null = null;
		for (const name of candidates.slice(0, 40)) {
			const id = name.slice(0, -5);
			next = id;
			try {
				const detail = await this.readAt(context.root, { ...request, id, libraryKey: context.key });
				const record = detail.record;
				const title = detail.kind === "experience-card" ? detail.record.problem : detail.record.originalRequirement;
				const source = detail.kind === "experience-card" ? (registry.projects.find((project) => project.biosProjectId === detail.record.sourceProjectId)?.displayName ?? detail.record.sourceProjectId) : (detail.record.customer.value ?? "");
				const searchable = detail.kind === "experience-card" ? [title, detail.record.symptom, detail.record.rootCause, detail.record.solution, source, id].join(" ") : [title, ...detail.record.aliases, source, detail.record.productLine.value, id].join(" ");
				if (query !== "" && !searchable.toLocaleLowerCase().includes(query)) continue;
				entries.push({ id, title: title.slice(0, 160), source, state: detail.kind === "experience-card" ? detail.record.status : detail.record.customer.status, revision: record.revision, updatedAt: record.updatedAt });
			} catch (error) {
				problems.push(`${id.slice(0, 100)}：${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
			}
		}
		this.current(context.key);
		return { libraryKey: context.key, root: context.root, entries, next: candidates.length > 40 ? next : null, scanIncomplete: listing.truncated, problems };
	}

	private async readAt(root: string, request: BiosLibraryRef): Promise<BiosLibraryDetail> {
		if (request.kind === "experience-card") return { kind: request.kind, record: (await readRecord({ root, kind: request.kind, id: request.id })).record };
		return { kind: request.kind, record: (await readRecord({ root, kind: request.kind, id: request.id })).record };
	}
	async detail(request: BiosLibraryRef): Promise<BiosLibraryDetail> {
		const context = this.current(request.libraryKey);
		const result = await this.readAt(context.root, request);
		this.current(context.key);
		return result;
	}

	/** Explicit local edit, not an LLM grant. Source IDs remain immutable. */
	async update(request: BiosLibraryUpdate): Promise<BiosLibraryReceipt> {
		const context = this.current(request.libraryKey);
		const gate = this.options.writeGate ?? this.fallbackGate;
		const result = await gate.write(context.root, async () => {
			this.current(context.key);
			if (request.kind === "feature-record") return updateFeature({ root: context.root, featureId: request.id, expectedRevision: request.expectedRevision, changes: request.changes });
			const record = (await readRecord({ root: context.root, kind: request.kind, id: request.id })).record;
			this.current(context.key);
			return updateExperienceDraft({ root: context.root, experienceId: request.id, expectedRevision: request.expectedRevision, changes: request.changes, authorizedProjectIds: [record.sourceProjectId] });
		});
		return { result, stable: this.isCurrent(context.key) };
	}

	/** Critical state changes still require the human dialog and audited domain entry. */
	async review(request: BiosLibraryReview): Promise<BiosLibraryReceipt> {
		if (request.confirmed !== true) throw new Error("请明确确认知识状态变更");
		const context = this.current(request.libraryKey);
		const result = await (this.options.writeGate ?? this.fallbackGate).write(context.root, async () => {
			const record = (await readRecord({ root: context.root, kind: "experience-card", id: request.id })).record;
			this.current(context.key);
			return reviewExperience({ root: context.root, experienceId: request.id, expectedRevision: request.expectedRevision, action: request.action, reason: request.reason, operatorLabel: "Local user", authorizedProjectIds: [record.sourceProjectId] });
		});
		return { result, stable: this.isCurrent(context.key) };
	}
	private isCurrent(key: string): boolean {
		try {
			this.current(key);
			return true;
		} catch {
			return false;
		}
	}
}
