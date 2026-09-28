import { createContext, forwardRef, useContext, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, LayoutGroup, motion, useIsPresent, useReducedMotion } from "motion/react";
import { EASE_OUT } from "../../lib/ease";
import { cn } from "../../lib/utils";

const RemovalGeneration = createContext(0);

/** 未过滤的数据 id 区分真实移除与搜索隐藏；只在移除时触发布局测量。 */
export function SidebarRemovalList(props: { remainingIds: readonly string[]; children: ReactNode; onExitComplete?: () => void }) {
	const groupId = useId();
	const previous = useRef<{ ids: ReadonlySet<string>; generation: number } | null>(null);
	const prior = previous.current;
	const unchanged = prior !== null && prior.ids.size === props.remainingIds.length && props.remainingIds.every((id) => prior.ids.has(id));
	const currentIds = unchanged ? prior.ids : new Set(props.remainingIds);
	const removed = prior !== null && !unchanged && [...prior.ids].some((id) => !currentIds.has(id));
	const generation = (prior?.generation ?? 0) + (removed ? 1 : 0);
	useLayoutEffect(() => {
		previous.current = { ids: currentIds, generation };
	}, [currentIds, generation]);
	return (
		<RemovalGeneration.Provider value={generation}>
			<LayoutGroup id={groupId} inherit={false}>
				<AnimatePresence initial={false} mode="popLayout" custom={props.remainingIds} onExitComplete={props.onExitComplete}>
					{props.children}
				</AnimatePresence>
			</LayoutGroup>
		</RemovalGeneration.Provider>
	);
}

// popLayout 需要直接取得这一行的 DOM，才能一次性移出文档流而非逐帧改高度。
export const SidebarRemovalRow = forwardRef<HTMLDivElement, { itemId: string; className?: string; children: ReactNode }>(function SidebarRemovalRow(props, ref) {
	const present = useIsPresent();
	const reduceMotion = useReducedMotion();
	const generation = useContext(RemovalGeneration);
	return (
		<motion.div
			ref={ref}
			data-sidebar-removal-id={props.itemId}
			inert={!present}
			aria-hidden={!present}
			className={cn(props.className, !present && "pointer-events-none")}
			initial={false}
			layout="position"
			layoutDependency={generation}
			transition={{ layout: { duration: reduceMotion ? 0 : 0.16, ease: EASE_OUT } }}
			exit="removed"
			variants={{
				removed: (remainingIds: readonly string[]) => ({
					opacity: 0,
					transition: { duration: reduceMotion || remainingIds.includes(props.itemId) ? 0 : 0.1, ease: EASE_OUT },
				}),
			}}
		>
			{props.children}
		</motion.div>
	);
});
