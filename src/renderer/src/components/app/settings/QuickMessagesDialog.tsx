import { ArrowDown, ArrowUp, FileJson, GripVertical, ListPlus, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { MAX_QUICK_MESSAGES, MAX_QUICK_MESSAGE_LENGTH } from "../../../../../shared/quickMessages";
import { useQuickMessageEditor } from "../../../hooks/useQuickMessageEditor";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { Input } from "../../ui-shadcn/input";

/**
 * 「管理快捷消息」弹框：条目清单的增删/排序/补充内置/恢复默认/重新读取/打开配置文件。
 *
 * 为什么从设置页搬到弹框里：条目上限 30 条，16 条出厂清单就能把设置页撑成一屏半，
 * 设置页只该留一行「条目预览 + 配置更多」（见 QuickMessagesSetting）。这里用弹框而不是
 * 内联展开，是为了给列表一个自己的滚动区（`max-h`），设置页高度不再随条目数变化。
 *
 * 写盘时序（打字合并 400ms、增删排序立即、关弹框补写）都在 useQuickMessageEditor 里，
 * 本组件只负责排版与事件转发。
 *
 * 列表 key 用下标：条目文本随输入实时变化，且允许存在重复/空行——用文本或 id 都会
 * 在编辑过程中重建节点、丢掉输入焦点。顺序调整本身就是重排，无状态可丢。
 */
export function QuickMessagesDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const editor = useQuickMessageEditor();
	const { rows } = editor;
	const latestRef = useRef({ rows, open: props.open, reorderItems: editor.reorderItems });
	latestRef.current = { rows, open: props.open, reorderItems: editor.reorderItems };
	const dragRef = useRef<{ index: number; rows: string[] } | null>(null);
	const [dropTarget, setDropTarget] = useState<number | null>(null);

	/** ref 是内部拖放的唯一来源；外部载荷即使伪造下标也不能触发排序。 */
	const clearDrag = useCallback(() => {
		dragRef.current = null;
		setDropTarget(null);
	}, []);

	useEffect(() => {
		// 下标只对开始拖动时那份列表有意义；增删/编辑/刷新和关闭都取消本次拖动。
		clearDrag();
		return () => {
			dragRef.current = null;
		};
	}, [rows, props.open, clearDrag]);

	/** 只允许把柄启动原生 HTML drag；自定义 MIME 仅让浏览器启动拖放，不携带消息正文。 */
	const startDrag = useCallback((event: DragEvent<HTMLButtonElement>, index: number) => {
		const current = latestRef.current;
		if (!current.open || index < 0 || index >= current.rows.length) {
			event.preventDefault();
			return;
		}
		event.stopPropagation();
		dragRef.current = { index, rows: current.rows };
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData("application/x-pideck-quick-message", "move");
	}, []);

	/** 拖放期间使用最新 ref 校验列表身份，不能让过期事件移动到另一条消息。 */
	const canDrop = useCallback((target: number) => {
		const current = latestRef.current;
		const source = dragRef.current;
		return current.open && source !== null && source.rows === current.rows && source.index >= 0 && source.index < current.rows.length && Number.isInteger(target) && target >= 0 && target < current.rows.length;
	}, []);

	const dragOver = useCallback(
		(event: DragEvent<HTMLDivElement>, target: number) => {
			// 同时拦住输入框默认接收文本/文件的行为，不把外部 drop 交给宿主处理。
			event.preventDefault();
			event.stopPropagation();
			const allowed = canDrop(target);
			event.dataTransfer.dropEffect = allowed ? "move" : "none";
			setDropTarget(allowed ? target : null);
		},
		[canDrop],
	);

	const drop = useCallback(
		(event: DragEvent<HTMLDivElement>, target: number) => {
			event.preventDefault();
			event.stopPropagation();
			const source = dragRef.current;
			const allowed = canDrop(target);
			clearDrag();
			if (allowed && source) latestRef.current.reorderItems(source.index, target);
		},
		[canDrop, clearDrag],
	);

	return (
		<Dialog
			open={props.open}
			onOpenChange={(open) => {
				if (!open) clearDrag();
				props.onOpenChange(open);
			}}
		>
			<DialogContent className="sm:max-w-[min(960px,calc(100vw-48px))] gap-3">
				<DialogHeader>
					<DialogTitle>{t("settings.quickMessages")}</DialogTitle>
					<DialogDescription>{t("settings.quickMessagesDesc", { max: MAX_QUICK_MESSAGES })}</DialogDescription>
					<p className="text-caption text-muted-foreground">{t("settings.quickMessagesConfigHint")}</p>
				</DialogHeader>

				{editor.loading ? (
					<p className="py-6 text-center text-caption text-muted-foreground">{t("settings.quickMessagesLoading")}</p>
				) : (
					<div className="flex min-h-0 flex-col gap-2">
						{/* 列表自己滚：条数再多也只占弹框高度，设置页与弹框都不跟着长高 */}
						<div className="flex max-h-[min(52vh,420px)] min-h-0 flex-col gap-1.5 overflow-y-auto pr-1">
							{rows.length === 0 ? <p className="py-3 text-caption text-muted-foreground">{t("settings.quickMessagesEmpty")}</p> : null}
							{rows.map((text, index) => (
								<div key={index} onDragOver={(event) => dragOver(event, index)} onDragLeave={() => setDropTarget(null)} onDrop={(event) => drop(event, index)} className={`flex min-w-0 items-center gap-1 rounded-md ${dropTarget === index ? "bg-accent ring-1 ring-inset ring-primary" : ""}`}>
									{/* 仅把柄可拖动，输入框仍可选字；键盘用户继续使用相邻的上下移按钮。 */}
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										tabIndex={-1}
										draggable
										title={t("settings.quickMessagesDragHandle")}
										aria-label={t("settings.quickMessagesDragHandle")}
										onDragStart={(event) => startDrag(event, index)}
										onDragEnd={clearDrag}
										className="shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing"
									>
										<GripVertical size={14} strokeWidth={1.8} aria-hidden="true" />
									</Button>
									<Input autoFocus={index === rows.length - 1 && text === ""} value={text} maxLength={MAX_QUICK_MESSAGE_LENGTH} placeholder={t("settings.quickMessagesPlaceholder")} onChange={(event) => editor.setItem(index, event.target.value)} onBlur={editor.flushPending} className="min-w-0 flex-1" />
									<Button type="button" variant="ghost" size="icon-sm" title={t("settings.quickMessagesMoveUp")} aria-label={t("settings.quickMessagesMoveUp")} disabled={index === 0} onClick={() => editor.moveItem(index, -1)}>
										<ArrowUp size={14} strokeWidth={1.8} aria-hidden="true" />
									</Button>
									<Button type="button" variant="ghost" size="icon-sm" title={t("settings.quickMessagesMoveDown")} aria-label={t("settings.quickMessagesMoveDown")} disabled={index === rows.length - 1} onClick={() => editor.moveItem(index, 1)}>
										<ArrowDown size={14} strokeWidth={1.8} aria-hidden="true" />
									</Button>
									<Button type="button" variant="ghost" size="icon-sm" title={t("settings.quickMessagesRemove")} aria-label={t("settings.quickMessagesRemove")} onClick={() => editor.removeItem(index)}>
										<Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
									</Button>
								</div>
							))}
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<Button type="button" variant="outline" size="sm" disabled={editor.atLimit} onClick={editor.addItem}>
								<Plus size={14} strokeWidth={2} aria-hidden="true" />
								{t("settings.quickMessagesAdd")}
							</Button>
							<Button type="button" variant="outline" size="sm" disabled={editor.merging || editor.atLimit} title={t("settings.quickMessagesMergeDefaultsHint")} onClick={() => void editor.mergeDefaults()}>
								<ListPlus size={14} strokeWidth={2} aria-hidden="true" />
								{t(editor.merging ? "settings.quickMessagesMerging" : "settings.quickMessagesMergeDefaults")}
							</Button>
							{editor.atLimit ? <span className="text-caption text-muted-foreground">{t("settings.quickMessagesLimit", { max: MAX_QUICK_MESSAGES })}</span> : null}
						</div>
					</div>
				)}

				{/* 个人文件与内置资源互不自动合并；恢复默认是整体替换，补充内置才保留现有顺序。 */}
				<DialogFooter className="sm:justify-between">
					<div className="flex flex-wrap items-center gap-1">
						<Button type="button" variant="ghost" size="sm" disabled={!editor.defaultsAvailable || editor.merging} title={editor.defaultsAvailable ? t("settings.quickMessagesResetHint") : t("settings.quickMessagesDefaultsUnavailable")} onClick={editor.resetDefaults}>
							<RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
							{t("settings.quickMessagesReset")}
						</Button>
						<Button type="button" variant="ghost" size="sm" disabled={editor.merging} title={t("settings.quickMessagesReloadHint")} onClick={() => void editor.reload()}>
							<RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
							{t("settings.quickMessagesReload")}
						</Button>
						<Button type="button" variant="ghost" size="sm" onClick={() => void editor.openFile()}>
							<FileJson size={14} strokeWidth={2} aria-hidden="true" />
							{t("settings.quickMessagesOpenFile")}
						</Button>
					</div>
					{/* 改动即时落盘，所以这里是「完成」而不是「保存」——没有可取消的草案 */}
					<DialogClose asChild>
						<Button type="button" variant="default" size="sm">
							{t("settings.quickMessagesDone")}
						</Button>
					</DialogClose>
				</DialogFooter>

				{editor.filePath ? <p className="break-all text-caption text-muted-foreground">{t("settings.quickMessagesFileHint", { path: editor.filePath })}</p> : null}
				{editor.error ? <p className="text-caption text-destructive">{editor.error}</p> : null}
			</DialogContent>
		</Dialog>
	);
}
