/** Human-only revocation: remains available without an active session/model grant. */
import { useEffect, useRef, useState } from "react";
import type { BiosConnectionList } from "../../../../shared/types/biosOnboarding";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";

export function BiosConnectionManager(props: { onChanged: () => Promise<unknown> }) {
	const [open, setOpen] = useState(false);
	const [list, setList] = useState<BiosConnectionList | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const epoch = useRef(0);
	// Archive retention is not an active connection; derive both views from the same fresh snapshot.
	const activeProjects = list?.projects.filter((project) => project.authorized) ?? [];
	const archivedProjects = list?.projects.filter((project) => !project.authorized) ?? [];
	useEffect(
		() => () => {
			epoch.current += 1;
		},
		[],
	);
	async function load() {
		const version = ++epoch.current;
		setBusy(true);
		setSelected(null);
		try {
			const next = await desktopApi.bios.connections();
			if (version === epoch.current) setList(next);
		} catch (error) {
			if (version === epoch.current) {
				setList(null);
				setNotice(String(error));
			}
		} finally {
			if (version === epoch.current) setBusy(false);
		}
	}
	async function disconnect() {
		if (!list || !selected || busy) return;
		const projectId = selected;
		const snapshot = list;
		setSelected(null);
		setBusy(true);
		try {
			const result = await desktopApi.bios.disconnectProject({ projectId, expectedRevision: snapshot.revision, configurationVersion: snapshot.configurationVersion, confirmed: true });
			setNotice(result.problem ?? (result.runtime.stopFailures.length ? t("bios.connections.stopFailed") : t("bios.connections.done")));
			await props.onChanged();
		} catch (error) {
			setNotice(String(error));
		} finally {
			await load();
		}
	}
	function projectRow(project: BiosConnectionList["projects"][number]) {
		return (
			<div key={project.projectId} data-testid={project.authorized ? "bios-connected-project" : "bios-archived-project"} className="rounded border border-border p-2">
				<div>
					{project.displayName} · {t(project.authorized ? "bios.connections.connected" : "bios.connections.retained")}
				</div>
				{project.paths.map((path) => (
					<div key={path} className="break-all text-text-muted">
						{path}
					</div>
				))}
				{project.authorized || project.desktopProjectId !== undefined ? (
					<Button size="sm" variant="outline" disabled={busy} onClick={() => setSelected(project.projectId)}>
						{t("bios.connections.disconnect")}
					</Button>
				) : null}
			</div>
		);
	}
	return (
		<section data-testid="bios-connection-manager" className="rounded-md border border-border p-3">
			<Button
				size="sm"
				variant="outline"
				disabled={busy}
				onClick={() => {
					setOpen(!open);
					if (!open) void load();
				}}
			>
				{t("bios.connections.manage")}
			</Button>
			{open ? (
				<div className="mt-2 flex flex-col gap-2">
					<div className="text-text-muted">{t("bios.connections.hint")}</div>
					<Button size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>
						{t("bios.workbench.refresh")}
					</Button>
					<div data-testid="bios-active-connections" className="flex flex-col gap-2">
						<div className="font-medium">{t("bios.connections.activeTitle")}</div>
						{list !== null && activeProjects.length === 0 ? <div className="text-text-muted">{t("bios.connections.empty")}</div> : null}
						{activeProjects.map(projectRow)}
					</div>
					{archivedProjects.length > 0 ? (
						<details data-testid="bios-archived-connections" className="rounded-md border border-border p-2">
							<summary className="cursor-pointer text-text-muted">{t("bios.connections.archiveTitle", { count: archivedProjects.length })}</summary>
							<div className="mt-2 flex flex-col gap-2">
								<div className="text-text-muted">{t("bios.connections.archiveHint")}</div>
								{archivedProjects.map(projectRow)}
							</div>
						</details>
					) : null}
				</div>
			) : null}
			{notice ? (
				<div role="status" className="mt-2 break-all text-text-muted">
					{notice}
				</div>
			) : null}
			{selected ? <ConfirmDialog title={t("bios.connections.disconnect")} message={t("bios.connections.confirm", { name: list?.projects.find((item) => item.projectId === selected)?.displayName ?? selected })} onCancel={() => setSelected(null)} onConfirm={() => void disconnect()} /> : null}
		</section>
	);
}
