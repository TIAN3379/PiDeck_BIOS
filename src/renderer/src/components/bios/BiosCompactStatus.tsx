import { useSetAtom } from "jotai";
import { biosOnboardingRequestAtom } from "../../atoms/bios-ui-atoms";
import type { BiosWorkbench } from "../../hooks/useBiosWorkbench";
import { useBiosConnectionStatus } from "../../hooks/useBiosConnectionStatus";
import { useBiosEndpointFacts } from "../../hooks/useBiosEndpointFacts";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";

/** Only facts needed while chatting; all management lives behind one explicit entry. */
export function BiosCompactStatus(props: { workbench: BiosWorkbench; desktopProjectId?: string; desktopProjectName?: string; onManage: () => void; onLibrary: () => void; onRestartRuntime?: () => void }) {
	const { workbench } = props;
	const status = useBiosConnectionStatus({ desktopProjectId: props.desktopProjectId, ready: workbench.storeStatus?.kind === "ready" });
	const request = useSetAtom(biosOnboardingRequestAtom);
	const service = useBiosEndpointFacts();
	const grant = workbench.settings.endpointGrant;
	const serviceKnown = service.agentId !== null && service.provider !== null && service.modelId !== null && service.endpointOrigin !== null;
	const needsServiceConsent = serviceKnown && (workbench.settings.endpoint !== "allowed" || (grant != null && (grant.provider !== service.provider || grant.modelId !== service.modelId || grant.origin !== service.endpointOrigin)));
	const automation = workbench.automationStatus;
	const connected = status.connection !== null;
	return (
		<section data-testid="bios-compact-status" className="flex flex-col gap-3 rounded-md border border-border p-3">
			<div className="flex items-center justify-between gap-2">
				<h3 className="font-medium">{t("bios.compact.title")}</h3>
				<Button size="sm" variant="ghost" data-testid="bios-manage-open" onClick={props.onManage}>
					{t("bios.compact.manage")}
				</Button>
			</div>
			{props.desktopProjectId === undefined ? (
				<p className="text-text-muted">{t("bios.compact.chat")}</p>
			) : (
				<>
					<p className="break-all">{props.desktopProjectName ?? status.connection?.displayName ?? t("bios.compact.project")}</p>
					<p data-testid="bios-compact-connection" className="text-text-muted">
						{t(status.loading ? "bios.workbench.loading" : status.problem !== null ? "bios.compact.unavailable" : status.conflict ? "bios.compact.conflict" : connected ? "bios.compact.connected" : "bios.compact.disconnected")}
					</p>
					{!connected && !status.loading && status.problem === null && !status.conflict ? (
						<Button className="self-start" size="sm" variant="outline" data-testid="bios-onboarding-open" onClick={() => request({ desktopProjectId: props.desktopProjectId ?? "", nonce: Date.now() })}>
							{t("bios.compact.connect")}
						</Button>
					) : null}
					{connected && needsServiceConsent ? (
						<Button className="self-start" size="sm" variant="outline" data-testid="bios-service-consent-open" onClick={() => request({ desktopProjectId: props.desktopProjectId ?? "", nonce: Date.now() })}>
							{t("bios.compact.confirmService")}
						</Button>
					) : null}
				</>
			)}
			<p data-testid="bios-compact-store" className="text-text-muted">
				{t(workbench.storeStatus?.kind === "ready" ? "bios.workbench.store.readyTitle" : workbench.storeStatus?.kind === "unconfigured" ? "bios.workbench.store.unconfiguredTitle" : "bios.compact.storeCheck")}
			</p>
			<Button size="sm" variant="outline" className="self-start" data-testid="bios-library-open" onClick={props.onLibrary}>
				{t("bios.library.open")}
			</Button>
			{props.desktopProjectId !== undefined && connected ? (
				<p data-testid="bios-workflow-automation-status" className="text-text-muted">
					{t(automation?.available ? (workbench.settings.automation.enabled ? "bios.compact.memoryOn" : "bios.compact.memoryOff") : "bios.compact.memoryUnavailable")}
				</p>
			) : null}
			{automation?.available && automation.receipt !== null && (automation.durableFailed > 0 || automation.durablePending > 0 || automation.durableUnrecovered > 0) ? (
				<p role="status" className="break-words text-destructive">
					{t("bios.workflow.automationReceipt", { detail: automation.receipt.detail })}
				</p>
			) : null}
			{workbench.runtime?.pendingRestart ? (
				<Button size="sm" variant="outline" disabled={!props.onRestartRuntime} onClick={props.onRestartRuntime}>
					{t("bios.firstRun.restart")}
				</Button>
			) : null}
			{workbench.runtime !== null && workbench.runtime.stopFailures.length > 0 ? (
				<p role="status" className="text-destructive">
					{t("bios.workbench.runtimeStopFailures")}
				</p>
			) : null}
			{status.problem !== null || workbench.problem !== null ? (
				<p role="status" className="break-all text-destructive">
					{status.problem ?? workbench.problem}
				</p>
			) : null}
			<p className="text-text-muted">{t("bios.compact.hint")}</p>
		</section>
	);
}
