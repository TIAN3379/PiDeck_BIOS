import type { AgentUiRequest } from "../../../../shared/types";
import { useAtomValue } from "jotai";
import { currentSessionIdAtom } from "../../atoms/session-atoms";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogContent, DialogTitle } from "../ui-shadcn/dialog";

/** BIOS critical confirmations keep the existing request/generation responder, only presentation changes. */
export function BiosRuntimeConfirm(props: { sessionId: string; request: AgentUiRequest; responding: boolean; onConfirm: () => void; onCancel: () => void }) {
	const currentSessionId = useAtomValue(currentSessionIdAtom);
	// Split/background sessions keep their own pending request, but cannot steal the focused session's modal.
	if (currentSessionId !== props.sessionId) return null;
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.responding) props.onCancel();
			}}
		>
			<DialogContent
				data-testid="bios-runtime-confirm"
				aria-describedby={undefined}
				showCloseButton={!props.responding}
				onInteractOutside={(event) => event.preventDefault()}
				onEscapeKeyDown={(event) => {
					if (props.responding) event.preventDefault();
				}}
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					document.getElementById("bios-runtime-cancel")?.focus();
				}}
			>
				<DialogTitle>{props.request.title}</DialogTitle>
				<p className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words text-control text-text-muted">{props.request.message}</p>
				<div className="flex justify-end gap-2">
					<Button id="bios-runtime-cancel" className="ask-inline-bar-option-no" variant="outline" disabled={props.responding} onClick={props.onCancel}>
						{t("common.cancel")}
					</Button>
					<Button className="ask-inline-bar-option-yes" disabled={props.responding} onClick={props.onConfirm}>
						{t("common.confirm")}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
