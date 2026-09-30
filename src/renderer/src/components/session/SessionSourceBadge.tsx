import type { AgentBackend, SessionSource } from "../../../../shared/types";
import { ImageIcon } from "lucide-react";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { Badge } from "../ui-shadcn/badge";

const SOURCE_LABELS: Record<SessionSource, string> = {
	pi: t("sessionSource.pi"),
	codex: t("sessionSource.codex"),
	claude: t("sessionSource.claude"),
	qoder: t("sessionSource.qoder"),
	opencode: t("sessionSource.opencode"),
	zcode: t("sessionSource.zcode"),
	workbuddy: t("sessionSource.workbuddy"),
	cursor: t("sessionSource.cursor"),
};

const SOURCE_TONES: Record<SessionSource, string> = {
	pi: "border-cyan-300/70 text-cyan-700 dark:border-cyan-700/70 dark:text-cyan-300",
	codex: "border-indigo-300/70 text-indigo-700 dark:border-indigo-700/70 dark:text-indigo-300",
	claude: "border-amber-300/70 text-amber-700 dark:border-amber-700/70 dark:text-amber-300",
	// opencode 官方品牌为黑白单色，不用品牌色（避免绿色观感）；中性灰随主题自适应
	opencode: "border-muted-foreground/40 text-muted-foreground",
	// zcode（z.ai CLI）无公开品牌图形资源，用中性色 + 自绘 Z 标记，避免错误品牌色
	zcode: "border-muted-foreground/40 text-muted-foreground",
	// WorkBuddy 同无公开品牌 SVG，沿用中性色 + 自绘 W 字形标记（与 zcode 惯例一致）
	workbuddy: "border-muted-foreground/40 text-muted-foreground",
	// Cursor 无随包品牌 SVG，用中性色 + 指针标记，避免误用第三方品牌色。
	cursor: "border-muted-foreground/40 text-muted-foreground",
	// Qoder 同样无随包品牌 SVG：自绘「Q」环形+尾笔标记，沿用中性色惯例（与 zcode/workbuddy 一致）。
	qoder: "border-muted-foreground/40 text-muted-foreground",
};

function SourceLogo(props: { source: SessionSource }) {
	// 品牌路径内联到渲染层，保证离线会话列表也能显示 Logo，不依赖远程图片或字体资源。
	if (props.source === "codex") {
		return (
			<svg viewBox="0 0 256 260" className="size-3.5" aria-hidden="true" focusable="false">
				<path
					fill="currentColor"
					d="M239.184 106.203a64.72 64.72 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.72 64.72 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.67 64.67 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.77 64.77 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483m-97.56 136.338a48.4 48.4 0 0 1-31.105-11.255l1.535-.87l51.67-29.825a8.6 8.6 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601M37.158 197.93a48.35 48.35 0 0 1-5.781-32.589l1.534.921l51.722 29.826a8.34 8.34 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803M23.549 85.38a48.5 48.5 0 0 1 25.58-21.333v61.39a8.29 8.29 0 0 0 4.195 7.316l62.874 36.272l-21.845 12.636a.82.82 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405zm179.466 41.695l-63.08-36.63L161.73 77.86a.82.82 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.54 8.54 0 0 0-4.4-7.213m21.742-32.69l-1.535-.922l-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.72.72 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391zM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87l-51.67 29.825a8.6 8.6 0 0 0-4.246 7.367zm11.868-25.58L128.067 97.3l28.188 16.218v32.434l-28.086 16.218l-28.188-16.218z"
				/>
			</svg>
		);
	}

	if (props.source === "claude") {
		return (
			<svg viewBox="0 0 256 176" className="size-3.5" aria-hidden="true" focusable="false">
				<path fill="currentColor" d="m147.487 0 70.081 175.78H256L185.919 0zM66.183 106.221l23.98-61.774 23.98 61.774zM70.07 0 0 175.78h39.18l14.33-36.914h73.308l14.328 36.914h39.179L110.255 0z" />
			</svg>
		);
	}

	if (props.source === "opencode") {
		return (
			<svg viewBox="0 0 24 24" className="size-3.5" aria-hidden="true" focusable="false">
				<path fill="currentColor" d="M22 24H2V0h20zM17 4.8H7v14.4h10z" />
			</svg>
		);
	}

	if (props.source === "zcode") {
		// z.ai ZCode 无公开品牌 SVG，用等宽「Z」字形作为可辨识标记；
		// 与 opencode 一样走中性色，名称经 title/aria-label 保留。
		return (
			<svg viewBox="0 0 24 24" className="size-3.5" aria-hidden="true" focusable="false">
				<path fill="currentColor" d="M4 3h16v3.2L10.8 16H20v5H4v-3.2L13.2 8H4z" />
			</svg>
		);
	}

	if (props.source === "workbuddy") {
		// WorkBuddy 无公开品牌 SVG，用等宽「W」字形作为可辨识标记（与 zcode 的 Z 同一惯例）。
		return (
			<svg viewBox="0 0 24 24" className="size-3.5" aria-hidden="true" focusable="false">
				<path fill="currentColor" d="M1.6 4h3.3l2.5 12.2L10 4h4l2.6 12.2L19.1 4h3.3l-3.9 16h-3.7l-2.8-12-2.8 12H5.5z" />
			</svg>
		);
	}

	if (props.source === "cursor") {
		// Cursor 现行品牌是立方体 logomark（cursor.com/brand），不是鼠标指针。
		// 三面等距立方体用 currentColor + 透明度，14px 徽章上仍能读出体积。
		return (
			<svg viewBox="0 0 24 24" className="size-3.5" aria-hidden="true" focusable="false">
				<path fill="currentColor" d="M12 2.2 20.8 7.2 12 12.2 3.2 7.2Z" />
				<path fill="currentColor" opacity="0.66" d="M3.2 7.2 12 12.2V21.8L3.2 16.8Z" />
				<path fill="currentColor" opacity="0.4" d="M12 12.2 20.8 7.2V16.8L12 21.8Z" />
			</svg>
		);
	}

	if (props.source === "qoder") {
		// 自绘「Q」：圆环（evenodd 挖空）+ 右下出环尾笔，14px 徽标上仍可辨认为字母 Q。
		return (
			<svg viewBox="0 0 24 24" className="size-3.5" aria-hidden="true" focusable="false">
				<path fill="currentColor" fillRule="evenodd" d="M11 2a9 9 0 1 0 5.2 16.3l3.2 3.2 2.1-2.1-3.2-3.2A9 9 0 0 0 11 2Zm0 3.3a5.7 5.7 0 1 1 0 11.4 5.7 5.7 0 0 1 0-11.4Z" />
			</svg>
		);
	}

	return (
		<svg viewBox="140 140 520 520" className="size-3.5" aria-hidden="true" focusable="false">
			<path fill="currentColor" fillRule="evenodd" d="M165.29 165.29H517.36V400H400v117.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" />
			<path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z" />
		</svg>
	);
}

/** pi 官方 logo（品牌窗口标记，来源徽章同款）。 */
export function PiLogo(props: { className?: string }) {
	return (
		<svg viewBox="140 140 520 520" className={props.className ?? "size-3.5"} aria-hidden="true" focusable="false">
			<path fill="currentColor" fillRule="evenodd" d="M165.29 165.29H517.36V400H400v117.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" />
			<path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z" />
		</svg>
	);
}

/** 生图后端文本标记；Pi 是默认后端，不额外显示。 */
export function SessionBackendBadge(props: { backend?: AgentBackend; className?: string }) {
	const backend = props.backend ?? "imagegen";
	const label = t("sessionBackend.imagegen");
	return (
		<Badge variant="outline" aria-label={label} title={label} data-backend={backend} className={cn("h-4 rounded border-violet-300/70 px-1 text-[9px] font-semibold leading-none tracking-wide text-violet-700 dark:border-violet-700/70 dark:text-violet-300", props.className)}>
			<ImageIcon className="mr-0.5 size-2.5" aria-hidden="true" />
			{label}
		</Badge>
	);
}

/**
 * 后端标识统一入口：Pi 是默认运行时，不额外显示 logo；只有非默认后端需要提示用户。
 * 这样保留来源信息的同时，避免每个普通 Pi 会话都增加一个视觉噪点。
 */
export function SessionBackendMark(props: { backend?: AgentBackend; className?: string }) {
	if (props.backend === "imagegen") {
		return <SessionBackendBadge backend={props.backend} className={props.className} />;
	}
	return null;
}

/**
 * 统一渲染会话来源标记：Badge 只承载品牌 Logo，不显示文字；名称通过 title 和 aria-label
 * 保留给悬停提示及辅助技术，避免用户无法区分相似 Logo。
 */
export function SessionSourceBadge(props: { source: SessionSource; label?: string; className?: string }) {
	const label = props.label ?? SOURCE_LABELS[props.source];
	return (
		<Badge variant="outline" aria-label={label} title={label} data-source={props.source} className={cn("size-5 rounded-md p-0", SOURCE_TONES[props.source], props.className)}>
			<SourceLogo source={props.source} />
		</Badge>
	);
}

/**
 * 生图过滤徽标（来源过滤菜单用）：与来源徽标同款描边徽标，但用图片图标而非品牌 logo，
 * 因为是独立后端而非品牌来源；tone 取紫色与 pi 区分。
 */
export function ImageGenSourceBadge(props: { className?: string }) {
	const label = t("sessionBackend.imagegen");
	return (
		<Badge variant="outline" aria-label={label} title={label} data-source="imagegen" className={cn("size-5 rounded-md p-0 border-violet-300/70 text-violet-700 dark:border-violet-700/70 dark:text-violet-300", props.className)}>
			<ImageIcon className="size-3" aria-hidden="true" />
		</Badge>
	);
}
