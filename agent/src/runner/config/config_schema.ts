/**
 * RunnerConfig 结构定义（强类型 + 中文注释）。
 *
 * 设计说明：
 * - 统一配置入口，避免 actions 内散落硬编码
 * - 所有执行入口（runSteps/trace）都应从这里读取配置
 * - 便于后续加入配置文件/环境变量覆盖
 */

export type WaitPolicy = {
    /** 默认操作超时（用于 click/fill 等通用操作） */
    defaultTimeoutMs: number;
    /** 导航超时（goto 等） */
    navigationTimeoutMs: number;
    /** A11y 快照超时（可用于 snapshot） */
    a11ySnapshotTimeoutMs: number;
    /** 元素可见等待超时 */
    visibleTimeoutMs: number;
    /** 稳定等待（页面 settle） */
    settleTimeoutMs: number;
};

export type RetryPolicy = {
    /** 是否启用重试 */
    enabled: boolean;
    /** 最大重试次数 */
    maxAttempts: number;
    /** 退避基准时间（毫秒），可用于 fixed/指数 */
    backoffMs: number;
    /** 允许重试的错误码 */
    retryableErrorCodes: string[];
};

export type HumanPolicy = {
    /** 是否启用拟人化行为 */
    enabled: boolean;
    /** click 延迟范围 */
    clickDelayMsRange: { min: number; max: number };
    /** type 延迟范围（预留） */
    typeDelayMsRange: { min: number; max: number };
    /** 滚动步长范围 */
    scrollStepPxRange: { min: number; max: number };
    /** 滚动延迟范围 */
    scrollDelayMsRange: { min: number; max: number };
    /** 空闲行为策略 */
    idleBehavior: 'none' | 'microScroll' | 'mouseMove';
};

export type Observability = {
    /** 是否启用 trace */
    traceEnabled: boolean;
    /** 是否输出 trace 参数（默认 false，避免泄露） */
    traceLogArgs: boolean;
    /** step 日志级别 */
    stepLogLevel: 'info' | 'debug';
    /** 出错时截图 */
    screenshotOnError: boolean;
};

export type RunnerConfig = {
    waitPolicy: WaitPolicy;
    retryPolicy: RetryPolicy;
    humanPolicy: HumanPolicy;
    observability: Observability;
};
