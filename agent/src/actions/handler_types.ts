import type { Page } from 'playwright';
import type { Action } from './action_protocol';
import type { PageRegistry } from '../runtime/page_registry';
import type { RecordingState } from '../record/recording';
import type { ReplayOptions } from '../play/replay';
import type { RunStepsDeps } from '../runner/run_steps';
import type { RuntimeWorkspace, WorkspaceRegistry } from '../runtime/workspace_registry';
import type { RuntimeTab } from '../runtime/tab_registry';

export type ActionContext = {
    workspaceRegistry: WorkspaceRegistry;
    workspace: RuntimeWorkspace | null;
    resolveTab: (tabName?: string) => RuntimeTab;
    resolvePage: (tabName?: string) => Page;
    pageRegistry: PageRegistry;
    log: (...args: unknown[]) => void;
    recordingState: RecordingState;
    replayOptions: ReplayOptions;
    navDedupeWindowMs: number;
    emit?: (action: Action) => void;
    execute?: (action: Action) => Promise<Action>;
    runStepsDeps?: RunStepsDeps;
};

export type ActionHandler = (ctx: ActionContext, action: Action) => Promise<Action>;
