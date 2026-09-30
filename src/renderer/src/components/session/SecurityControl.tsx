import { SecurityLevelMenu } from "./SecurityLevelMenu";

/**
 * 底栏安全控制位统一入口（C20）：目前唯一实现是 pi 的内置安全等级菜单
 * （SecurityLevelMenu，SecurityStore 会话级覆盖，安全门热更新）。
 * 新增后端运行时只在这里注册控制位，不再在 ComposerArea 写 if/else。
 */
export function SecurityControl(props: { sessionId: string; disabled?: boolean }) {
	return <SecurityLevelMenu sessionId={props.sessionId} disabled={props.disabled} />;
}
