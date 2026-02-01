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
    | 'browser.go_back'
    | 'browser.reload'
    | 'browser.create_tab'
    | 'browser.switch_tab'
    | 'browser.close_tab'
    | 'browser.get_page_info'
    | 'browser.snapshot'
    | 'browser.take_screenshot'
    | 'browser.click'
    | 'browser.fill'
    | 'browser.type'
    | 'browser.select_option'
    | 'browser.hover'
    | 'browser.scroll'
    | 'browser.press_key'
    | 'browser.drag_and_drop'
    | 'browser.mouse';

export type A11yHint = {
    role?: string;
    name?: string;
    text?: string;
};

export type Target = {
    a11yNodeId?: string;
    a11yHint?: A11yHint;
    selector?: string;
};

export type StepArgsMap = {
    'browser.goto': { url: string; timeout?: number };
    'browser.go_back': { timeout?: number };
    'browser.reload': { timeout?: number };
    'browser.create_tab': { url?: string };
    'browser.switch_tab': { tab_id: string };
    'browser.close_tab': { tab_id?: string };
    'browser.get_page_info': Record<string, never>;
    'browser.snapshot': { includeA11y?: boolean; focus_only?: boolean };
    'browser.take_screenshot': { target?: Target; full_page?: boolean; a11yNodeId?: string; a11yHint?: A11yHint };
    'browser.click': {
        target?: Target;
        coord?: { x: number; y: number };
        options?: { button?: 'left' | 'right' | 'middle'; double?: boolean };
        timeout?: number;
        a11yNodeId?: string;
        a11yHint?: A11yHint;
    };
    'browser.fill': { target?: Target; value: string; timeout?: number; a11yNodeId?: string; a11yHint?: A11yHint };
    'browser.type': {
        target?: Target;
        text: string;
        delay_ms?: number;
        timeout?: number;
        a11yNodeId?: string;
        a11yHint?: A11yHint;
    };
    'browser.select_option': { target?: Target; values: string[]; timeout?: number; a11yNodeId?: string; a11yHint?: A11yHint };
    'browser.hover': { target?: Target; timeout?: number; a11yNodeId?: string; a11yHint?: A11yHint };
    'browser.scroll': {
        target?: Target;
        direction?: 'up' | 'down';
        amount?: number;
        timeout?: number;
        a11yNodeId?: string;
        a11yHint?: A11yHint;
    };
    'browser.press_key': { key: string; target?: Target; timeout?: number; a11yNodeId?: string; a11yHint?: A11yHint };
    'browser.drag_and_drop': {
        source: Target;
        dest_target?: Target;
        dest_coord?: { x: number; y: number };
        timeout?: number;
    };
    'browser.mouse': {
        action: 'move' | 'down' | 'up' | 'wheel';
        x: number;
        y: number;
        deltaY?: number;
        button?: 'left' | 'right' | 'middle';
    };
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
