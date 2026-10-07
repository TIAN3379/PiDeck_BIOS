/** 面向工程师的接入入口：名称与目录可理解，内部身份仅在高级信息中展示。 */
import { useBiosOnboarding } from "../../hooks/useBiosOnboarding";
import { useAtomValue } from "jotai";
import { currentSessionIdAtom } from "../../atoms/session-atoms";
import { useBiosEndpointFacts } from "../../hooks/useBiosEndpointFacts";
import type { BiosWorkbench } from "../../hooks/useBiosWorkbench";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Checkbox } from "../ui-shadcn/checkbox";
import { Input } from "../ui-shadcn/input";
import { BiosAnalysisDraftButton } from "./BiosAnalysisDraftButton";

export function BiosProjectOnboarding(props: { desktopProjectId?: string; workbench: BiosWorkbench }) {
	// R2：项目打开后**自动提议**接入（可取消），不再要求用户先点「预览接入」。
	const facts = useBiosEndpointFacts();
	const sessionId = useAtomValue(currentSessionIdAtom);
	const live = facts.agentId !== null && facts.generation !== null && facts.provider !== null && facts.modelId !== null && facts.endpointOrigin !== null;
	const form = useBiosOnboarding({
		desktopProjectId: props.desktopProjectId,
		sessionId,
		autoPrepare: true,
		serviceKey: live ? JSON.stringify([facts.sessionId, facts.agentId, facts.generation, facts.provider, facts.modelId, facts.endpointOrigin]) : "",
		serviceRef: live ? { agentId: facts.agentId ?? "", sessionId: facts.sessionId, generation: facts.generation ?? 0 } : null,
	});
	const service = form.preview?.service;
	const serviceReady = live && service != null && service.provider === facts.provider && service.modelId === facts.modelId && service.origin === facts.endpointOrigin;
	const ready = props.workbench.storeStatus?.kind === "ready";
	const result = form.result;
	return (
		<section data-testid="bios-onboarding" className="flex flex-col gap-2 rounded-md border border-border p-3 text-[12px]">
			<div className="font-medium">{t("bios.onboarding.title")}</div>
			<p className="text-text-muted">{form.hint}</p>
			{!ready ? <p className="text-text-muted">{t("bios.onboarding.storeNotReadyHint")}</p> : null}
			{props.desktopProjectId === undefined ? <p className="text-text-muted">{t("bios.workbench.project.needDesktopProject")}</p> : null}
			{form.preview !== null ? (
				<>
					<label className="flex flex-col gap-1">
						{t("bios.onboarding.name")}
						<Input aria-label={t("bios.onboarding.name")} value={form.name} onChange={(event) => form.setName(event.target.value)} readOnly={form.preview.existing} maxLength={120} disabled={form.busy} className="h-8 text-[12px]" />
					</label>
					<div className="break-all">
						<span className="text-text-muted">{t("bios.onboarding.directory")} </span>
						{form.preview.workspacePath}
					</div>
					<p className="text-text-muted">{form.preview.existing ? t("bios.onboarding.reuse") : t("bios.onboarding.new")}</p>
					{form.preview.rootAction === "create-default" ? <p className="text-text-muted">{t("bios.onboarding.createDefaultRoot")}</p> : null}
					<details className="text-text-muted">
						<summary className="cursor-pointer">{t("bios.onboarding.advanced")}</summary>
						<p className="mt-1 break-all">{form.preview.biosProjectId}</p>
					</details>
					<label className="flex items-start gap-2 rounded-md border border-border p-2">
						<Checkbox data-testid="bios-onboarding-automation" aria-label={t("bios.onboarding.automation")} checked={form.automation} disabled={form.busy} onCheckedChange={(checked) => form.setAutomation(checked === true)} />
						<span>{t("bios.onboarding.automation")}</span>
					</label>
					<label className="flex items-start gap-2 rounded-md border border-border p-2">
						<Checkbox data-testid="bios-onboarding-consent" aria-label={t("bios.onboarding.consent")} checked={form.confirmed} disabled={form.busy} onCheckedChange={(checked) => form.setConfirmed(checked === true)} />
						<span>{t("bios.onboarding.consent")}</span>
					</label>
					<div className="break-all" data-testid="bios-onboarding-model-service">
						{service == null ? t("bios.firstRun.actualEndpointUnknown") : `${service.provider} / ${service.modelId} · ${service.origin}`}
					</div>
					<label className="flex items-start gap-2 rounded-md border border-border p-2">
						<Checkbox data-testid="bios-onboarding-endpoint-consent" aria-label={t("bios.firstRun.endpointConsent")} checked={form.endpointConsent} disabled={form.busy || !serviceReady} onCheckedChange={(checked) => form.setEndpointConsent(checked === true)} />
						<span>{t("bios.firstRun.endpointConsent")}</span>
					</label>
					<p className="text-text-muted">{t("bios.onboarding.permissionHint")}</p>
					<div className="flex flex-wrap gap-2">
						<Button
							size="sm"
							disabled={form.busy || !form.confirmed || !form.name.trim()}
							onClick={() =>
								void form.confirm().then((outcome) => {
									if (outcome !== null) void props.workbench.refresh();
								})
							}
						>
							{t("bios.onboarding.confirm")}
						</Button>
						<Button size="sm" variant="ghost" disabled={form.busy} onClick={form.cancel}>
							{t("bios.onboarding.cancel")}
						</Button>
					</div>
				</>
			) : (
				// R2：知识库未就绪不再是硬门槛——宿主会提议默认库，确认时一次创建。
				<Button className="self-start" size="sm" disabled={props.desktopProjectId === undefined || form.busy} onClick={() => void form.prepare()}>
					{form.busy ? t("bios.onboarding.loading") : t("bios.onboarding.prepare")}
				</Button>
			)}
			{result !== null ? (
				<div role="status" className="flex flex-col gap-1 border-t border-border pt-2">
					<p className="font-medium">{result.status === "completed" ? t("bios.onboarding.completed") : t("bios.onboarding.partial")}</p>
					<p>{result.authorization === null ? t("bios.onboarding.authorizationFailed") : t("bios.onboarding.authorizationSaved")}</p>
					{result.authorization?.runtime.pendingRestart ? <p className="text-text-muted">{t("bios.onboarding.restartHint")}</p> : null}
					{result.authorization?.runtime.stopFailures.length ? <p className="text-destructive">{t("bios.workbench.runtimeStopFailures")}</p> : null}
					{result.problem ? <p className="break-all text-destructive">{result.problem}</p> : null}
					{result.binding !== null ? (
						<details className="text-text-muted">
							<summary className="cursor-pointer">{t("bios.onboarding.steps")}</summary>
							{result.binding.result.steps.map((step) => (
								<p key={step.step}>{`${step.step}: ${step.status}${step.detail ? ` — ${step.detail}` : ""}`}</p>
							))}
						</details>
					) : null}
					{result.status === "completed" ? <BiosAnalysisDraftButton desktopProjectId={props.desktopProjectId} biosProjectId={result.preview.biosProjectId} /> : null}
				</div>
			) : null}
			{form.problem !== null ? (
				<p role="status" className="break-all text-destructive">
					{form.problem}
				</p>
			) : null}
		</section>
	);
}
