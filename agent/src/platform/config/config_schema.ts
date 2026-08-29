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
    /** 页面就绪等待超时 */
    pageReadyTimeoutMs: number;
    /** click 候选单次尝试超时 */
    candidateClickTimeoutMs: number;
    /** action 前目标高亮时长 */
    highlightBeforeActionMs: number;
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
    /** console 输出最低日志级别（所有类型统一） */
    consoleLogLevel: 'debug' | 'info' | 'warning' | 'error';
    /** file 输出最低日志级别（所有类型统一） */
    fileLogLevel: 'debug' | 'info' | 'warning' | 'error';
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
    /** 是否在控制台输出 step 日志 */
    stepConsoleEnabled: boolean;
    /** 是否将 step 日志写入文件 */
    stepFileEnabled: boolean;
    /** step 日志输出路径 */
    stepFilePath: string;
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
    /** 是否在控制台输出 infra 日志 */
    infraConsoleEnabled: boolean;
    /** 是否将 infra 日志写入文件 */
    infraFileEnabled: boolean;
    /** infra 日志输出路径 */
    infraFilePath: string;
    /** 是否在控制台输出 ext 转发日志 */
    extConsoleEnabled: boolean;
    /** 是否将 ext 转发日志写入文件 */
    extFileEnabled: boolean;
    /** ext 转发日志输出路径 */
    extFilePath: string;
    /** 是否在控制台输出 entity 日志 */
    entityConsoleEnabled: boolean;
    /** 是否将 entity 日志写入文件 */
    entityFileEnabled: boolean;
    /** entity 日志输出路径 */
    entityFilePath: string;
    /** 是否在控制台输出 dsl 日志 */
    dslConsoleEnabled: boolean;
    /** 是否将 dsl 日志写入文件 */
    dslFileEnabled: boolean;
    /** dsl 日志输出路径 */
    dslFilePath: string;
    /** 出错时截图 */
    screenshotOnError: boolean;
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

export type EntityRuleConfig = {
    enabled: boolean;
    rootDir: string;
    selection: 'disabled' | 'explicit' | 'auto';
    profiles: string[];
    strict: boolean;
};

export type IrreversibleApprovalMode = 'deny' | 'require-human' | 'allow';

export type InteractionPolicy = 'interactive' | 'headless';

export type AgentModelDefaults = {
    /** 默认 provider 名（provider/model/baseUrl 三者同时为空表示未配置，回退到环境变量） */
    provider: string;
    /** 默认模型 id */
    model: string;
    /** provider 兼容终端地址 */
    baseUrl: string;
    /** 认证令牌引用（形式：env:VAR_NAME | file:PATH），永不存放明文密钥 */
    apiKeyRef: string;
};

export type AgentServiceBinding = {
    /** 监听地址 */
    host: string;
    /** 监听端口（0 表示自动分配）；范围内 [0, 65535] */
    port: number;
    /** Agent 服务 HTTP 路径 */
    agentPath: string;
    /** 健康检查路径 */
    healthPath: string;
};

export type GovernanceBudget = {
    /** 最大决策轮数 */
    maxTurns: number;
    /** 最大工具调用数 */
    maxToolCalls: number;
    /** 最大外部世界副作用数 */
    maxWorldEffects: number;
    /** 出错后可执行的最大副作用数 */
    maxPostErrorEffects: number;
    /** 最大恢复尝试数 */
    maxRecoveryAttempts: number;
    /** 墙钟截止时间（毫秒） */
    wallClockDeadlineMs: number;
    /** 不可逆操作审批模式 */
    irreversibleApproval: IrreversibleApprovalMode;
};

export type RetentionPolicy = {
    /** 保留时长（毫秒）；0 表示不按时间限制 */
    maxAgeMs: number;
    /** 最大保留条目数；0 表示不限制数量 */
    maxCount: number;
};

export type SessionRetentionConfig = {
    /** 会话持久化根目录 */
    storageRoot: string;
    retention: RetentionPolicy;
};

export type ReportRetentionConfig = {
    /** 运行报告根目录 */
    root: string;
    retention: RetentionPolicy;
};

export type AgentAuthConfig = {
    /** 是否启用承载令牌鉴权 */
    enabled: boolean;
    /** 令牌引用（形式：env:VAR_NAME | file:PATH），永不存放明文密钥 */
    tokenRef: string;
};

export type AgentConfig = {
    model: AgentModelDefaults;
    service: AgentServiceBinding;
    governance: GovernanceBudget;
    sessions: SessionRetentionConfig;
    reports: ReportRetentionConfig;
    auth: AgentAuthConfig;
    interaction: InteractionPolicy;
};

export type RunnerConfig = {
    waitPolicy: WaitPolicy;
    retryPolicy: RetryPolicy;
    humanPolicy: HumanPolicy;
    observability: Observability;
    checkpointPolicy: CheckpointPolicy;
    mcpPolicy: McpPolicy;
    entityRules: EntityRuleConfig;
    agent: AgentConfig;
};
