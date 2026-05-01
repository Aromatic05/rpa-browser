/**
 * 通用类型定义：收敛扩展内部散落的结构，便于跨层复用与维护。
 *
 * 设计要点：
 * - 类型只描述“协议形状”，不包含具体实现逻辑。
 * - 与 agent 侧协议兼容，字段名保持一致（workspaceName）。
 */
export type WorkspaceName = string;
export type TabName = string;

/**
 * 协议硬约束（禁止回退为 RPC）：
 * - Action 是 extension 内部与 extension ↔ agent 的唯一业务消息单元。
 * - 请求/回复/失败/流式事件都必须是 Action（通过 replyTo 关联）。
 * - 不允许在 Action.payload 中重新封装 { ok, data } / { ok, error }。
 */
export type Action<T extends string = string, P = unknown> = {
    v: 1;
    id: string;
    type: T;
    workspaceName?: WorkspaceName;
    payload?: P;
    at?: number;
    traceId?: string;
    replyTo?: string;
};
