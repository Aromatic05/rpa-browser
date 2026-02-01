/**
 * Step 模型：统一 MCP / play / script 的最小执行单元。
 *
 * 设计目标：
 * - 所有入口只传 Step 列表给 runSteps
 * - Step 本身只描述“要做什么”，不携带 Page/Locator 等运行时对象
 * - 通过强类型映射约束 name 与 args 的对应关系
 */

export type StepName =
    | 'browser.goto'
    | 'browser.snapshot'
    | 'browser.click'
    | 'browser.fill';

export type StepArgsMap = {
    'browser.goto': { url: string; timeout?: number };
    'browser.snapshot': { includeA11y?: boolean };
    'browser.click': { a11yNodeId?: string; a11yHint?: A11yHint; timeout?: number };
    'browser.fill': { a11yNodeId?: string; a11yHint?: A11yHint; value: string };
};

export type A11yHint = {
    role?: string;
    name?: string;
    text?: string;
};

export type StepMeta = {
    requestId?: string;
    source: 'mcp' | 'play' | 'script';
    ts?: number;
};

export type Step<TName extends StepName = StepName> = {
    id: string;
    name: TName;
    args: StepArgsMap[TName];
    meta?: StepMeta;
};

export type StepUnion = {
    [Name in StepName]: Step<Name>;
}[StepName];

export type StepResult = {
    stepId: string;
    ok: boolean;
    data?: unknown;
    error?: { code: string; message: string; details?: unknown };
};

export type RunStepsRequest = {
    workspaceId: string;
    steps: StepUnion[];
    options?: { dryRun?: boolean; stopOnError?: boolean; maxConcurrency?: number };
};

export type RunStepsResult = {
    ok: boolean;
    results: StepResult[];
    trace?: { count?: number; lastEvents?: unknown[] };
};
