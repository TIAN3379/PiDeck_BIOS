/** Human-friendly record contents; full stored evidence remains inspectable read-only. */
import type { BiosLibraryDetail as Detail } from "../../../../../shared/types/biosLibrary";
import { t } from "../../../i18n";

export function BiosLibraryDetail(props: { detail: Detail }) {
	const detail = props.detail;
	const record = detail.record;
	const fields =
		detail.kind === "experience-card"
			? [
					[t("bios.workbench.knowledge.reference.problem"), detail.record.problem],
					[t("bios.workbench.knowledge.reference.symptom"), detail.record.symptom ?? ""],
					[t("bios.workbench.knowledge.reference.rootCause"), detail.record.rootCause],
					[t("bios.workbench.knowledge.reference.solution"), detail.record.solution],
					[t("bios.workbench.knowledge.reference.appliesWhen"), detail.record.appliesWhen.join("\n")],
					[t("bios.workbench.knowledge.reference.doesNotApplyWhen"), detail.record.doesNotApplyWhen.join("\n")],
				]
			: [
					[t("bios.workbench.knowledge.feature.originalRequirement"), detail.record.originalRequirement],
					[t("bios.workbench.knowledge.feature.customer"), detail.record.customer.value ?? ""],
					[t("bios.workbench.knowledge.feature.productLine"), detail.record.productLine.value ?? ""],
					[t("bios.workbench.knowledge.feature.aliases"), detail.record.aliases.join("\n")],
					[t("bios.workbench.knowledge.feature.acceptanceCriteria"), detail.record.acceptanceCriteria.join("\n")],
				];
	return (
		<>
			<dl className="flex flex-col gap-3">
				{fields.map(([label, value]) => (
					<div key={label}>
						<dt className="font-medium text-text-muted">{label}</dt>
						<dd className="mt-1 whitespace-pre-wrap break-words">{value || "—"}</dd>
					</div>
				))}
			</dl>
			<details className="mt-3 rounded border border-border p-2">
				<summary className="cursor-pointer">{t("bios.library.fullRecord")}</summary>
				<pre data-testid="bios-library-full-record" className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-[11px]">
					{JSON.stringify(record, null, 2)}
				</pre>
			</details>
		</>
	);
}
