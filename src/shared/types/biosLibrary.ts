/** Human-only local knowledge management. No Pi identity or model consent is required. */
import type { ExperienceCard, ExperienceDraft, ExperienceReviewResult, ExperienceWriteResult, FeatureDraft, FeatureRecord, FeatureWriteResult } from "./biosBusiness";

export type BiosLibraryKind = "experience-card" | "feature-record";
export type BiosLibraryEntry = { readonly id: string; readonly title: string; readonly revision: number; readonly updatedAt: number; readonly state: string; readonly source: string };
export type BiosLibraryListRequest = { readonly kind: BiosLibraryKind; readonly query?: string; readonly after?: string; readonly libraryKey?: string };
export type BiosLibraryPage = {
	readonly libraryKey: string;
	readonly root: string;
	readonly entries: readonly BiosLibraryEntry[];
	readonly next: string | null;
	readonly scanIncomplete: boolean;
	readonly problems: readonly string[];
};
export type BiosLibraryRef = { readonly kind: BiosLibraryKind; readonly id: string; readonly libraryKey: string };
export type BiosLibraryDetail = { readonly kind: "experience-card"; readonly record: ExperienceCard } | { readonly kind: "feature-record"; readonly record: FeatureRecord };
export type BiosLibraryUpdate =
	| (BiosLibraryRef & { readonly kind: "experience-card"; readonly expectedRevision: number; readonly changes: Partial<Omit<ExperienceDraft, "experienceId" | "sourceProjectId">> })
	| (BiosLibraryRef & { readonly kind: "feature-record"; readonly expectedRevision: number; readonly changes: Partial<Omit<FeatureDraft, "featureId">> });
export type BiosLibraryReview = BiosLibraryRef & { readonly kind: "experience-card"; readonly expectedRevision: number; readonly action: "request-changes" | "deprecate" | "restore"; readonly reason: string; readonly confirmed: true };
export type BiosLibraryWriteResult = ExperienceWriteResult | FeatureWriteResult;
export type BiosLibraryReceipt<T = BiosLibraryWriteResult | ExperienceReviewResult> = { readonly result: T; readonly stable: boolean };
