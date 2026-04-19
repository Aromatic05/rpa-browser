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
    /** 交互步骤硬超时（用于防止步骤整体卡死） */
    interactionTimeoutMs: number;
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
    /** action 最低日志级别 */
    actionLogLevel: 'debug' | 'info' | 'warning' | 'error';
    /** record 最低日志级别 */
    recordLogLevel: 'debug' | 'info' | 'warning' | 'error';
    /** trace 最低日志级别 */
    traceLogLevel: 'debug' | 'info' | 'warning' | 'error';
    /** step 最低日志级别 */
    stepLogLevel: 'debug' | 'info' | 'warning' | 'error';
    /** 是否启用 trace */
    traceEnabled: boolean;
    /** 是否输出 trace 参数（默认 false，避免泄露） */
    traceLogArgs: boolean;
    /** 是否在控制台输出 trace 日志 */
    traceConsoleEnabled: boolean;
    /** 是否将 trace 日志写入文件 */
    traceFileEnabled: boolean;
    /** trace 日志输出路径 */
    traceFilePath: string;
    /** 是否在控制台输出 action 日志 */
    actionConsoleEnabled: boolean;
    /** 是否将 action/execute 日志写入文件 */
    actionFileEnabled: boolean;
    /** action/execute 日志输出路径 */
    actionFilePath: string;
    /** 是否在控制台输出 record 日志 */
    recordConsoleEnabled: boolean;
    /** 是否将 record 日志写入文件 */
    recordFileEnabled: boolean;
    /** record 日志输出路径 */
    recordFilePath: string;
    /** 出错时截图 */
    screenshotOnError: boolean;
};

export type ConfidencePolicy = {
    /** 是否启用置信度判定 */
    enabled: boolean;
    /** 置信度阈值（0-1） */
    minScore: number;
    /** role 匹配权重 */
    roleWeight: number;
    /** name 匹配权重 */
    nameWeight: number;
    /** text 匹配权重 */
    textWeight: number;
    /** selector 命中加分 */
    selectorBonus: number;
};

export type CheckpointPolicy = {
    /** 是否启用 task.run checkpoint 持久化 */
    enabled: boolean;
    /** checkpoint 文件路径（相对项目根目录） */
    filePath: string;
    /** 自动刷盘间隔（毫秒） */
    flushIntervalMs: number;
};

export type McpToolGroup = 'tab_navigation' | 'structured_inspection' | 'business_entities' | 'actions' | 'debugging';

export type McpPolicy = {
    /** 启用的工具分组（空数组表示不过滤分组） */
    enabledToolGroups: McpToolGroup[];
    /** 额外强制启用的工具名 */
    enableTools: string[];
    /** 强制禁用的工具名 */
    disableTools: string[];
};

export type RunnerConfig = {
    waitPolicy: WaitPolicy;
    retryPolicy: RetryPolicy;
    humanPolicy: HumanPolicy;
    observability: Observability;
    confidencePolicy: ConfidencePolicy;
    checkpointPolicy: CheckpointPolicy;
    mcpPolicy: McpPolicy;
};
