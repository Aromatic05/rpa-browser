import type { Locator, Page } from 'playwright';
import type { PageRegistry } from '../../../runtime/browser/page_registry';
import type { ToolResult, TraceContext, TraceOpName } from '../types';

export type CreateToolsOptions = {
    pageRegistry?: PageRegistry;
    workspaceName?: string;
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
