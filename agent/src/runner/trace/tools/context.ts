import type { Locator, Page } from 'playwright';
import type { PageRegistry } from '../../../runtime/browser/page_registry';
import type { Action } from '../../../actions/action_protocol';
import type { ToolResult, TraceContext, TraceOpName } from '../types';

export type CreateToolsOptions = {
    pageRegistry?: PageRegistry;
    workspaceName?: string;
    dispatchAction?: (action: Action) => Promise<Action>;
};

export type RunOp = <T>(op: TraceOpName, args: unknown, fn: () => Promise<T>) => Promise<ToolResult<T>>;

export type ToolsBuildContext = {
    opts: CreateToolsOptions;
    ctx: TraceContext;
    getCurrentPage: () => Page;
    setCurrentPage: (page: Page) => void;
    run: RunOp;
    ensureA11yCache: () => Promise<void>;
    resolveSelectorLocator: (selector: string) => Promise<Locator>;
};
