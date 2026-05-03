import type { Action } from './action_protocol';
import { classifyActionRoute } from './classify';
import { parseActionEnvelope } from './envelope';
import { routeControlAction, type GatewayDeps } from './control_gateway';
import { routeWorkspaceAction } from './workspace_gateway';
import { toFailedAction, unsupportedActionFailure } from './results';
import type { WorkspaceRegistry } from '../runtime/workspace_registry';

export type ActionDispatcherOptions = {
    workspaceRegistry: WorkspaceRegistry;
    log: (...args: unknown[]) => void;
    emit?: (action: Action) => void;
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
                log: options.log,
                emit: options.emit,
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
