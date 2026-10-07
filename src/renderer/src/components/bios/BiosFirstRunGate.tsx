/**
 * C5/D4：**不依赖 BIOS 右栏**的首次接入提议。
 *
 * 问题：接入卡原先挂在右抽屉里，右栏关闭时"项目打开 ⇒ 一次必要确认"这条链根本不存在。
 * 这里把它做成根级浮层（与命令面板引导同级），项目打开后由宿主自动准备一次**可取消**的提议。
 *
 * D4 补齐的四件事：
 * 1. 卡上显示**当前实际模型**（provider / 模型 id）+ 全局外发策略 + 资料范围；模型信息不等于已验证 URL；
 * 2. 端点外发是**显式勾选**（默认未勾选）：勾选才写 `endpoint=allowed`，从不静默放行；
 * 3. 未授权/拒绝时明确说明"普通开发继续，BIOS 知识检索与自动注入暂不可用"；
 * 4. 回执按**真实终结结果**显示：completed / partial / 停止失败 / 待重开，不无条件说"已生效"。
 */
import { useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { currentSessionIdAtom } from "../../atoms/session-atoms";
import { biosOnboardingRequestAtom } from "../../atoms/bios-ui-atoms";
import { desktopApi } from "../../desktopApi";
import { useBiosEndpointFacts } from "../../hooks/useBiosEndpointFacts";
import { useBiosOnboarding } from "../../hooks/useBiosOnboarding";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Checkbox } from "../ui-shadcn/checkbox";
import { Input } from "../ui-shadcn/input";
import { Dialog, DialogContent, DialogTitle } from "../ui-shadcn/dialog";

type HostFacts = { readonly knowledgeRoot: string | null; readonly endpoint: string; readonly automationEnabled: boolean; readonly grant: { readonly provider: string; readonly modelId: string; readonly origin: string } | null };

export function BiosFirstRunGate(props: { desktopProjectId?: string; desktopProjectName?: string; onRestartRuntime?: () => void }) {
	const endpointFacts = useBiosEndpointFacts();
	const sessionId = useAtomValue(currentSessionIdAtom);
	const request = useAtomValue(biosOnboardingRequestAtom);
	const setRequest = useSetAtom(biosOnboardingRequestAtom);
	/**
	 * D4：把**当前会话引用**交给接入流程；只有它能让主进程核对真实模型服务并写入具名许可。
	 *
	 * 事实不完整（没有运行态、读不到 provider/模型/地址）时不提交引用——服务端会拒绝授权，
	 * 界面也据此禁用勾选，不制造"看起来授权了其实没有"的状态。
	 */
	const liveBound = endpointFacts.agentId !== null && endpointFacts.generation !== null && endpointFacts.provider !== null && endpointFacts.modelId !== null && endpointFacts.endpointOrigin !== null;
	const form = useBiosOnboarding({
		desktopProjectId: props.desktopProjectId,
		sessionId,
		autoPrepare: true,
		serviceKey: liveBound ? JSON.stringify([endpointFacts.sessionId, endpointFacts.agentId, endpointFacts.generation, endpointFacts.provider, endpointFacts.modelId, endpointFacts.endpointOrigin]) : "",
		serviceRef: liveBound ? { agentId: endpointFacts.agentId ?? "", sessionId: endpointFacts.sessionId, generation: endpointFacts.generation ?? 0 } : null,
	});
	const [host, setHost] = useState<HostFacts | null>(null);
	// Manual retry reuses this single owner; changing a project must not replay an old request.
	useEffect(() => {
		if (request === null) return;
		setRequest(null);
		if (request.desktopProjectId === props.desktopProjectId) void form.prepare();
	}, [request, props.desktopProjectId, form.prepare, setRequest]);
	const token = form.preview?.token ?? null;
	const done = form.result !== null;
	// 只在"有提议或有回执"时读一次宿主事实；不轮询、不在空闲时读配置。
	useEffect(() => {
		if (token === null && !done) return;
		let alive = true;
		void desktopApi.bios
			.getSettings()
			.then((settings) => {
				if (!alive) return;
				const grant = settings.endpointGrant ?? null;
				setHost({ knowledgeRoot: settings.knowledgeRoot, endpoint: settings.endpoint, automationEnabled: settings.automation.enabled, grant: grant === null ? null : { provider: grant.provider, modelId: grant.modelId, origin: grant.origin } });
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, [token, done]);

	if (props.desktopProjectId === undefined) return null;
	const preview = form.preview;
	const result = form.result;
	if (preview === null && result === null && form.problem === null) return null;
	const runtime = result?.authorization?.runtime;
	const policy = result?.authorization?.settings.endpoint ?? preview?.endpoint ?? host?.endpoint ?? null;
	const knowledgeRoot = preview?.knowledgeRoot ?? host?.knowledgeRoot ?? null;
	// D4：端点是否已明确允许外发；未授权时要在卡上说清楚"哪些能力暂时不可用"。
	const endpointAllowed = policy === "allowed";
	// D4：已绑定的具名许可与**当前实际**模型服务是否一致——不一致就是旧许可（资料不会外发）。
	const grant = result?.authorization?.settings.endpointGrant ?? preview?.endpointGrant ?? host?.grant ?? null;
	const grantMatchesLive = grant !== null && liveBound && grant.provider === endpointFacts.provider && grant.modelId === endpointFacts.modelId && grant.origin === endpointFacts.endpointOrigin;
	const grantStale = grant !== null && liveBound && !grantMatchesLive;
	const effectiveAllowed = endpointAllowed && (grant === null || grantMatchesLive);
	const serviceOnly = preview?.existing === true && preview.authorized === true;
	const serviceTitle = serviceOnly || (result?.status === "completed" && result.preview.existing && result.binding === null);
	const shownService = preview?.service ?? null;
	const serviceReady = liveBound && shownService !== null && shownService.provider === endpointFacts.provider && shownService.modelId === endpointFacts.modelId && shownService.origin === endpointFacts.endpointOrigin;
	// Existing projects need only a changed-service consent, not another onboarding operation.
	// A legacy allowed policy has no named service to invalidate. Preserve its existing
	// semantics without repeatedly interrupting an already connected project.
	if (serviceOnly && (!liveBound || (endpointAllowed && (grantMatchesLive || grant === null)))) return null;
	const formatService = (value: { readonly provider: string; readonly modelId: string; readonly origin: string }): string => `${value.provider}/${value.modelId}@${value.origin}`;

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !form.busy) form.cancel();
			}}
		>
			<DialogContent
				data-testid="bios-first-run"
				aria-describedby={undefined}
				showCloseButton={!form.busy}
				onEscapeKeyDown={(event) => {
					if (form.busy) event.preventDefault();
				}}
				onInteractOutside={(event) => event.preventDefault()}
				className="max-h-[calc(100vh-3rem)] overflow-y-auto sm:max-w-xl"
			>
				<DialogTitle>{t(serviceTitle ? "bios.firstRun.serviceTitle" : "bios.firstRun.title")}</DialogTitle>
				<div className="flex flex-col gap-2 p-3 text-[12px]">
					{preview !== null ? (
						<>
							<p className="text-text-muted">{t(serviceOnly ? "bios.firstRun.serviceBody" : "bios.firstRun.body")}</p>
							<dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
								<dt className="text-text-muted">{t("bios.onboarding.name")}</dt>
								<dd className="break-all">
									<Input aria-label={t("bios.onboarding.name")} value={form.name || preview.displayName} readOnly={preview.existing} disabled={form.busy} maxLength={120} onChange={(event) => form.setName(event.target.value)} className="h-8 text-[12px]" />
								</dd>
								<dt className="text-text-muted">{t("bios.onboarding.directory")}</dt>
								<dd className="break-all">{preview.workspacePath}</dd>
								<dt className="text-text-muted">{t("bios.firstRun.knowledgeRoot")}</dt>
								<dd className="break-all">
									{knowledgeRoot ?? t("bios.firstRun.knowledgeRootMissing")}
									{preview.rootAction === "create-default" ? `（${t("bios.onboarding.createDefaultRoot")}）` : ""}
								</dd>
								{/* D4：**实际**模型端点事实（读不到就说读不到，不拿策略枚举冒充）。 */}
								<dt className="text-text-muted">{t("bios.firstRun.actualModel")}</dt>
								<dd className="break-all" data-testid="bios-first-run-model">
									{endpointFacts.provider === null && endpointFacts.modelId === null ? t("bios.firstRun.actualModelUnknown") : [endpointFacts.provider, endpointFacts.modelId ?? endpointFacts.modelName].filter((value) => typeof value === "string" && value !== "").join(" / ")}
								</dd>
								<dt className="text-text-muted">{t("bios.firstRun.actualEndpoint")}</dt>
								<dd className="break-all" data-testid="bios-first-run-endpoint-origin">
									{endpointFacts.endpointOrigin ?? t("bios.firstRun.actualEndpointUnknown")}
								</dd>
								<dt className="text-text-muted">{t("bios.firstRun.endpoint")}</dt>
								<dd data-testid="bios-first-run-endpoint">
									{policy === "allowed" ? t("bios.firstRun.endpointAllowed") : policy === "denied" ? t("bios.firstRun.endpointDenied") : t("bios.firstRun.endpointUnknown")} — {t(endpointAllowed && grant === null ? "bios.firstRun.endpointLegacyHint" : "bios.firstRun.endpointHint")}
								</dd>
								<dt className="text-text-muted">{t("bios.firstRun.scope")}</dt>
								<dd className="break-all">{t("bios.firstRun.scopeValue")}</dd>
							</dl>
							{!serviceOnly ? (
								<label className="flex items-start gap-2 rounded-md border border-border p-2">
									<Checkbox data-testid="bios-first-run-automation" aria-label={t("bios.onboarding.automation")} checked={form.automation} disabled={form.busy} onCheckedChange={(checked) => form.setAutomation(checked === true)} />
									<span>{t("bios.onboarding.automation")}</span>
								</label>
							) : null}
							{/* D4：端点外发**默认未勾选**；勾选才写 allowed，从不静默放行。
						    读不到真实模型服务（或已绑定到当前服务）时不可勾选——避免写一个核对不了的许可。 */}
							<label className="flex items-start gap-2 rounded-md border border-border p-2">
								<Checkbox data-testid="bios-first-run-endpoint-consent" aria-label={t("bios.firstRun.endpointConsent")} checked={form.endpointConsent} disabled={form.busy || !serviceReady || (endpointAllowed && grantMatchesLive)} onCheckedChange={(checked) => form.setEndpointConsent(checked === true)} />
								<span>
									{t("bios.firstRun.endpointConsent")}
									{endpointAllowed && grantMatchesLive ? `（${t("bios.firstRun.endpointAlreadyAllowed")}）` : ""}
								</span>
							</label>
							{!serviceReady ? (
								<p data-testid="bios-first-run-endpoint-needs-session" className="text-text-muted">
									{t("bios.firstRun.endpointConsentNeedsSession")}
								</p>
							) : null}
							{grantStale ? (
								<p data-testid="bios-first-run-endpoint-grant-stale" className="text-destructive">
									{t("bios.firstRun.endpointGrantStale", { granted: formatService(grant), current: formatService({ provider: endpointFacts.provider ?? "", modelId: endpointFacts.modelId ?? "", origin: endpointFacts.endpointOrigin ?? "" }) })}
								</p>
							) : null}
							{/* 未授权外发时**在确认前**就说清后果：知识能力暂不可用，普通开发继续。 */}
							{!effectiveAllowed && !form.endpointConsent ? (
								<p data-testid="bios-first-run-endpoint-not-allowed" className="text-text-muted">
									{t("bios.firstRun.endpointNotAllowed")}
								</p>
							) : null}
							{/* 必要授权必须由人明确勾选：自动提议 ≠ 自动放行。 */}
							{!serviceOnly ? (
								<label className="flex items-start gap-2 rounded-md border border-border p-2">
									<Checkbox data-testid="bios-first-run-consent" aria-label={t("bios.onboarding.consent")} checked={form.confirmed} disabled={form.busy} onCheckedChange={(checked) => form.setConfirmed(checked === true)} />
									<span>{t("bios.onboarding.consent")}</span>
								</label>
							) : null}
							<div className="flex flex-wrap items-center gap-2">
								<Button size="sm" disabled={form.busy || (serviceOnly ? !form.endpointConsent || !serviceReady : !form.confirmed) || form.name.trim() === ""} onClick={() => void form.confirm()}>
									{t(serviceOnly ? "bios.firstRun.serviceConfirm" : "bios.onboarding.confirm")}
								</Button>
								<Button size="sm" variant="ghost" disabled={form.busy} onClick={form.cancel}>
									{t("bios.onboarding.cancel")}
								</Button>
								{form.busy ? <span className="text-text-muted">{t("bios.onboarding.loading")}</span> : null}
							</div>
						</>
					) : null}
					{result !== null ? (
						<div role="status" className="flex flex-col gap-1 border-t border-border pt-2">
							{/* D4：按**真实终结结果**显示，partial/失败不再冒充"已接入"。 */}
							<div>{result.status === "completed" ? t(result.preview.existing && result.binding === null ? "bios.firstRun.serviceSaved" : "bios.firstRun.done") : t("bios.firstRun.partial")}</div>
							{result.authorization === null ? <p className="text-destructive">{t("bios.onboarding.authorizationFailed")}</p> : null}
							{runtime?.pendingRestart === true ? (
								<>
									<p className="text-text-muted">{t("bios.firstRun.runtimePending")}</p>
									<Button size="sm" variant="outline" className="self-start" data-testid="bios-first-run-restart" disabled={props.onRestartRuntime === undefined} onClick={() => props.onRestartRuntime?.()}>
										{t("bios.firstRun.restart")}
									</Button>
								</>
							) : runtime === undefined || result.status !== "completed" ? null : (
								<p className="text-text-muted">{t("bios.firstRun.runtimeApplied")}</p>
							)}
							{/* 未授权端点时必须说清楚"普通开发继续，但 BIOS 知识能力暂不可用"。 */}
							{effectiveAllowed ? null : (
								<p data-testid="bios-first-run-endpoint-unsupported" className="text-text-muted">
									{t("bios.firstRun.endpointNotAllowed")}
								</p>
							)}
							{runtime !== undefined && runtime.stopFailures.length > 0 ? <p className="text-destructive">{t("bios.workbench.runtimeStopFailures")}</p> : null}
							{result.problem !== null ? <p className="break-all text-destructive">{result.problem}</p> : null}
							{result.status === "partial" ? (
								<Button size="sm" variant="outline" onClick={() => void form.prepare()}>
									{t("bios.onboarding.prepare")}
								</Button>
							) : null}
							<Button size="sm" variant="ghost" className="self-start" onClick={form.cancel}>
								{t("common.close")}
							</Button>
						</div>
					) : null}
					{form.problem !== null ? (
						<p role="status" className="break-all text-destructive">
							{form.problem}
						</p>
					) : null}
					{preview === null && result === null && form.problem !== null ? (
						<Button size="sm" variant="outline" onClick={() => void form.prepare()}>
							{t("bios.onboarding.prepare")}
						</Button>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}
