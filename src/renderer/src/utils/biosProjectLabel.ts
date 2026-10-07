/** 旧档案兼容：显示名优先，缺失时短 ID；完整内部 ID 仍在高级入口保留。 */
export function biosProjectLabel(project: { projectId: string; displayName?: string }): string {
	return project.displayName?.trim() || project.projectId.slice(0, 8);
}
