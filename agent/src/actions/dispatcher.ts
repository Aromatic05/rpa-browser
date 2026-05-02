import type { Action } from './action_protocol';
import { classifyActionRoute } from './classify';
import { parseActionEnvelope } from './envelope';
import { routeControlAction, type GatewayDeps } from './control_gateway';
import { routeWorkspaceAction } from './workspace_gateway';
import { toFailedAction, unsupportedActionFailure } from './failure';
import type { PageRegistry } from '../runtime/page_registry';
import type { RecordingState } from '../record/recording';
import type { ReplayOptions } from '../play/replay';
import type { RunStepsDeps } from '../runner/run_steps';
import type { WorkspaceRegistry } from '../runtime/workspace_registry';

export type ActionDispatcherOptions = {
    pageRegistry: PageRegistry;
    workspaceRegistry: WorkspaceRegistry;
    recordingState: RecordingState;
    log: (...args: unknown[]) => void;
    replayOptions: ReplayOptions;
    navDedupeWindowMs: number;
    emit?: (action: Action) => void;
    runStepsDeps?: RunStepsDeps;
};

export type ActionDispatcher = {
    dispatch(action: Action): Promise<Action>;
};

export const createActionDispatcher = (options: ActionDispatcherOptions): ActionDispatcher => ({
    async dispatch(action: Action): Promise<Action> {
        try {
            const parsed = parseActionEnvelope(action);
            const route = classifyActionRoute(parsed);
            const deps: GatewayDeps = {
                workspaceRegistry: options.workspaceRegistry,
                pageRegistry: options.pageRegistry,
                recordingState: options.recordingState,
                log: options.log,
                replayOptions: options.replayOptions,
                navDedupeWindowMs: options.navDedupeWindowMs,
                emit: options.emit,
                runStepsDeps: options.runStepsDeps,
            };

            if (route === 'control') {
                return await routeControlAction(deps, parsed);
            }
            if (route === 'workspace') {
                return await routeWorkspaceAction(deps, parsed);
            }
            if (route === 'reply' || route === 'event') {
                return unsupportedActionFailure(parsed);
            }
            return unsupportedActionFailure(parsed);
        } catch (error) {
            return toFailedAction(action, error);
        }
    },
});
