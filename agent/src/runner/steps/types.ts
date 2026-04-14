/**
 * Step 模型：统一 MCP / play / script 的最小执行单元。
 *
 * 设计目标：
 * - 所有入口只传 Step 列表给 runSteps
 * - Step 本身只描述“要做什么”，不携带 Page/Locator 等运行时对象
 * - 通过强类型映射约束 name 与 args 的对应关系
 */

import type { EntityKind, SnapshotFilter } from './executors/snapshot/core/types';

export type StepName =
    | 'browser.goto'
    | 'browser.go_back'
    | 'browser.reload'
    | 'browser.create_tab'
    | 'browser.switch_tab'
    | 'browser.close_tab'
    | 'browser.get_page_info'
    | 'browser.snapshot'
    | 'browser.get_content'
    | 'browser.read_console'
    | 'browser.read_network'
    | 'browser.evaluate'
    | 'browser.take_screenshot'
    | 'browser.click'
    | 'browser.fill'
    | 'browser.type'
    | 'browser.select_option'
    | 'browser.hover'
    | 'browser.scroll'
    | 'browser.press_key'
    | 'browser.drag_and_drop'
    | 'browser.mouse'
    | 'browser.list_entities'
    | 'browser.get_entity'
    | 'browser.find_entities'
    | 'browser.add_entity'
    | 'browser.delete_entity'
    | 'browser.rename_entity';

export type A11yHint = {
    role?: string;
    name?: string;
    text?: string;
};

export type Target = {
    id?: string;
    selector?: string;
    a11yNodeId?: string;
    a11yHint?: A11yHint;
};

export type StepArgsMap = {
    'browser.goto': { url: string; timeout?: number };
    'browser.go_back': { timeout?: number };
    'browser.reload': { timeout?: number };
    'browser.create_tab': { url?: string };
    'browser.switch_tab': { tab_id: string; tab_url?: string; tab_ref?: string };
    'browser.close_tab': { tab_id?: string };
    'browser.get_page_info': Record<string, never>;
    'browser.snapshot': {
        includeA11y?: boolean;
        focus_only?: boolean;
        refresh?: boolean;
        contain?: string;
        depth?: number;
        filter?: SnapshotFilter;
        diff?: boolean;
    };
    'browser.get_content': { ref: string };
    'browser.read_console': { limit?: number };
    'browser.read_network': { limit?: number };
    'browser.evaluate': { expression: string; arg?: unknown; mutatesPage?: boolean };
    'browser.take_screenshot': {
        id?: string;
        selector?: string;
        target?: Target;
        full_page?: boolean;
        a11yNodeId?: string;
        a11yHint?: A11yHint;
    };
    'browser.click': {
        id?: string;
        selector?: string;
        target?: Target;
        coord?: { x: number; y: number };
        options?: { button?: 'left' | 'right' | 'middle'; double?: boolean };
        timeout?: number;
        a11yNodeId?: string;
        a11yHint?: A11yHint;
    };
    'browser.fill': {
        id?: string;
        selector?: string;
        target?: Target;
        value: string;
        timeout?: number;
        a11yNodeId?: string;
        a11yHint?: A11yHint;
    };
    'browser.type': {
        id?: string;
        selector?: string;
        target?: Target;
        text: string;
        delay_ms?: number;
        timeout?: number;
        a11yNodeId?: string;
        a11yHint?: A11yHint;
    };
    'browser.select_option': {
        id?: string;
        selector?: string;
        target?: Target;
        values: string[];
        timeout?: number;
        a11yNodeId?: string;
        a11yHint?: A11yHint;
    };
    'browser.hover': {
        id?: string;
        selector?: string;
        target?: Target;
        timeout?: number;
        a11yNodeId?: string;
        a11yHint?: A11yHint;
    };
    'browser.scroll': {
        id?: string;
        selector?: string;
        target?: Target;
        direction?: 'up' | 'down';
        amount?: number;
        timeout?: number;
        a11yNodeId?: string;
        a11yHint?: A11yHint;
    };
    'browser.press_key': {
        key: string;
        id?: string;
        selector?: string;
        target?: Target;
        timeout?: number;
        a11yNodeId?: string;
        a11yHint?: A11yHint;
    };
    'browser.drag_and_drop': {
        source: Target;
        dest_target?: Target;
        dest_coord?: { x: number; y: number };
        timeout?: number;
    };
    'browser.mouse': {
        action: 'move' | 'down' | 'up' | 'wheel' | 'click' | 'dblclick';
        x: number;
        y: number;
        deltaY?: number;
        button?: 'left' | 'right' | 'middle';
    };
    'browser.list_entities': {
        kind?: EntityKind | EntityKind[];
        businessTag?: string | string[];
        query?: string;
    };
    'browser.get_entity': {
        nodeId: string;
    };
    'browser.find_entities': {
        query: string;
        kind?: EntityKind | EntityKind[];
        businessTag?: string | string[];
    };
    'browser.add_entity': {
        nodeId: string;
        kind: EntityKind;
        name?: string;
        businessTag?: string;
    };
    'browser.delete_entity': {
        nodeId: string;
        kind?: EntityKind;
        businessTag?: string;
    };
    'browser.rename_entity': {
        nodeId: string;
        name: string;
    };
};

export type StepMeta = {
    requestId?: string;
    source: 'mcp' | 'play' | 'script' | 'record';
    ts?: number;
    workspaceId?: string;
    tabId?: string;
    tabToken?: string;
    tabRef?: string;
    urlAtRecord?: string;
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
