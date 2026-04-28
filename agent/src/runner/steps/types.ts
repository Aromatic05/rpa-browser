/**
 * Step 模型：统一 MCP / play / script 的最小执行单元。
 *
 * 设计目标：
 * - 所有入口只传 Step 列表给 runSteps
 * - Step 本身只描述“要做什么”，不携带 Page/Locator 等运行时对象
 * - 通过强类型映射约束 name 与 args 的对应关系
 */

import type { BBox, EntityKind, SnapshotFilter } from './executors/snapshot/core/types';

export type StepName =
    | 'browser.goto'
    | 'browser.go_back'
    | 'browser.reload'
    | 'browser.create_tab'
    | 'browser.switch_tab'
    | 'browser.close_tab'
    | 'browser.get_page_info'
    | 'browser.list_tabs'
    | 'browser.snapshot'
    | 'browser.capture_resolve'
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
    | 'browser.entity'
    | 'browser.assert'
    | 'browser.query'
    | 'browser.compute'
    | 'browser.checkpoint';

export type ResolvePolicy = {
    preferDirect?: boolean;
    preferScoped?: boolean;
    requireVisible?: boolean;
    allowFuzzy?: boolean;
    allowIndexDrift?: boolean;
};

export type QueryNodeLike = {
    id: string;
    role?: string;
    tag?: string;
    text?: string;
    attrs?: Record<string, string>;
    children?: string[];
    handle?: {
        nodeId: string;
    };
};

export type BrowserQueryResult =
    | {
          kind: 'value';
          value: unknown;
          meta?: Record<string, unknown>;
      }
    | {
          kind: 'nodeId';
          nodeId: string;
          meta?: Record<string, unknown>;
      }
    | {
          kind: 'nodeIds';
          nodeIds: string[];
          count: number;
          meta?: Record<string, unknown>;
      };

export type QueryFromRef =
    | 'snapshot'
    | 'snapshot.latest'
    | {
          nodeIds: string[];
      }
    | {
          nodes: Array<
              | {
                    id: string;
                }
              | {
                    handle: {
                        nodeId: string;
                    };
                }
          >;
      };

export type ComputeRef = {
    path: string;
};

export type ComputeExpr = {
    op: 'len' | 'exists' | 'first' | 'get' | 'eq' | 'not' | 'and' | 'or';
    args: ComputeValue[];
};

export type ComputeValue = { literal: unknown } | { ref: ComputeRef } | ComputeExpr;

export type ResolveHint = {
    entity?: {
        businessTag?: string;
        fieldKey?: string;
        actionIntent?: string;
    };
    target?: {
        nodeId?: string;
        primaryDomId?: string;
        sourceDomIds?: string[];
        role?: string;
        tag?: string;
        name?: string;
        text?: string;
        attrs?: Record<string, string>;
        bbox?: BBox;
    };
    locator?: {
        direct?: {
            kind: string;
            query: string;
            fallback?: string;
        };
        scope?: {
            id: string;
            kind?: string;
        };
        origin?: {
            primaryDomId?: string;
            sourceDomIds?: string[];
        };
    };
    raw?: {
        selector?: string;
        locatorCandidates?: Array<{
            kind: string;
            selector?: string;
            testId?: string;
            role?: string;
            name?: string;
            text?: string;
            exact?: boolean;
            note?: string;
        }>;
        scopeHint?: string;
        targetHint?: string;
    };
    capture?: {
        source: 'capture_resolve';
        confidence: number;
        reason: string[];
        warnings: string[];
    };
};

export type StepResolve = {
    hint?: ResolveHint;
    policy?: ResolvePolicy;
};

export type StepArgsMap = {
    'browser.goto': { url: string; timeout?: number };
    'browser.go_back': { timeout?: number };
    'browser.reload': { timeout?: number };
    'browser.create_tab': { url?: string };
    'browser.switch_tab': { tabId?: string; tabUrl?: string; tabRef?: string };
    'browser.close_tab': { tabId?: string; tabRef?: string };
    'browser.get_page_info': Record<string, never>;
    'browser.list_tabs': Record<string, never>;
    'browser.snapshot': {
        includeA11y?: boolean;
        focus_only?: boolean;
        refresh?: boolean;
        contain?: string;
        depth?: number;
        filter?: SnapshotFilter;
        diff?: boolean;
    };
    'browser.capture_resolve': {
        nodeId?: string;
        selector?: string;
        text?: string;
        role?: string;
        name?: string;
        limit?: number;
    };
    'browser.get_content': { ref: string };
    'browser.read_console': { limit?: number };
    'browser.read_network': { limit?: number };
    'browser.evaluate': { expression: string; arg?: unknown; mutatesPage?: boolean };
    'browser.take_screenshot': {
        nodeId?: string;
        selector?: string;
        resolveId?: string;
        full_page?: boolean;
        inline?: boolean;
    };
    'browser.click': {
        nodeId?: string;
        selector?: string;
        resolveId?: string;
        coord?: { x: number; y: number };
        options?: { button?: 'left' | 'right' | 'middle'; double?: boolean };
        timeout?: number;
    };
    'browser.fill': {
        nodeId?: string;
        selector?: string;
        resolveId?: string;
        value: string;
        timeout?: number;
    };
    'browser.type': {
        nodeId?: string;
        selector?: string;
        resolveId?: string;
        text: string;
        delay_ms?: number;
        timeout?: number;
    };
    'browser.select_option': {
        nodeId?: string;
        selector?: string;
        resolveId?: string;
        values: string[];
        timeout?: number;
    };
    'browser.hover': {
        nodeId?: string;
        selector?: string;
        resolveId?: string;
        timeout?: number;
    };
    'browser.scroll': {
        nodeId?: string;
        selector?: string;
        resolveId?: string;
        direction?: 'up' | 'down';
        amount?: number;
        timeout?: number;
    };
    'browser.press_key': {
        key: string;
        nodeId?: string;
        selector?: string;
        resolveId?: string;
        timeout?: number;
    };
    'browser.drag_and_drop': {
        sourceNodeId?: string;
        sourceSelector?: string;
        sourceResolveId?: string;
        destNodeId?: string;
        destSelector?: string;
        destResolveId?: string;
        destCoord?: { x: number; y: number };
        timeout?: number;
    };
    'browser.mouse': {
        action: 'move' | 'down' | 'up' | 'wheel' | 'click' | 'dblclick';
        x: number;
        y: number;
        deltaY?: number;
        button?: 'left' | 'right' | 'middle';
    };
    'browser.entity':
        | {
              op: 'list';
              kind?: EntityKind | EntityKind[];
              businessTag?: string | string[];
              query?: string;
          }
        | {
              op: 'get';
              nodeId: string;
          }
        | {
              op: 'find';
              kind?: EntityKind | EntityKind[];
              businessTag?: string | string[];
              query?: string;
          }
        | {
              op: 'add';
              nodeId: string;
              kind: EntityKind;
              name?: string;
              businessTag?: string;
          }
        | {
              op: 'delete';
              nodeId: string;
              kind?: EntityKind;
              businessTag?: string;
          }
        | {
              op: 'rename';
              nodeId: string;
              name: string;
          };
    'browser.assert': {
        urlIncludes?: string;
        textVisible?: string;
        entityExists?: {
            query: string;
            kind?: EntityKind | EntityKind[];
            businessTag?: string | string[];
        };
    };
    'browser.query':
        | {
              from: QueryFromRef;
              where?: {
                  role?: string;
                  tag?: string;
                  text?: {
                      contains?: string;
                  };
                  attrs?: Record<string, string>;
              };
              relation?: 'child' | 'descendant';
              limit?: number;
          }
        | {
              op: 'entity';
              businessTag: string;
              query:
                  | 'table.row_count'
                  | 'table.headers'
                  | 'table.primary_key'
                  | 'table.columns'
                  | 'table.current_rows'
                  | 'table.hasNextPage'
                  | 'table.nextPageTarget'
                  | 'form.fields'
                  | 'form.actions';
          }
        | {
              op: 'entity.target';
              businessTag: string;
              target:
                  | {
                        kind: 'form.field';
                        fieldKey: string;
                    }
                  | {
                        kind: 'form.action';
                        actionIntent: string;
                    }
                  | {
                        kind: 'table.row';
                        primaryKey: {
                            fieldKey: string;
                            value: string;
                        };
                    }
                  | {
                        kind: 'table.row_action';
                        primaryKey: {
                            fieldKey: string;
                            value: string;
                        };
                        actionIntent: string;
                    };
          };
    'browser.compute': {
        expr: ComputeExpr;
    };
    'browser.checkpoint': {
        checkpointId: string;
        input?: Record<string, unknown>;
    };
};

export type StepMeta = {
    requestId?: string;
    source: 'mcp' | 'play' | 'script' | 'record' | 'control-rpc';
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
    /**
     * Runtime-only metadata. It is not serialized into core steps.yaml.
     */
    meta?: StepMeta;
    /**
     * Runtime-only resolve data. It is not serialized into core steps.yaml.
     * Persist resolve data in step_resolve.yaml and reference it with resolveId.
     */
    resolve?: StepResolve;
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
    stepResolves?: Record<string, StepResolve>;
    options?: { dryRun?: boolean; stopOnError?: boolean; maxConcurrency?: number };
};

export type RunStepsResult = {
    ok: boolean;
    results: StepResult[];
    trace?: { count?: number; lastEvents?: unknown[] };
};
