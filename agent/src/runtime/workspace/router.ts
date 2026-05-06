/**
 * WorkspaceRouter — prefix-only forwarder.
 *
 * DISCIPLINE:
 * - This file ONLY forwards workspace-scoped actions to their respective
 *   control handlers based on the action type prefix.
 * - It MUST NOT parse domain payloads.
 * - It MUST NOT construct domain business replies.
 * - It MUST NOT directly operate on workspace.tabs or workspace.mcp.
 * - It MUST NOT handle control actions (those are routed through control_plane).
 */
import type { Action } from '../../actions/action_protocol';
import { ActionError } from '../../actions/results';
import { ERROR_CODES } from '../../actions/results';
import type { RuntimeWorkspace, WorkspaceRegistry } from './registry';
import type { ControlPlaneResult } from '../control_plane';
import type { RecordControl } from '../../record/control';
import type { DslControl } from '../../dsl/control';
import type { CheckpointControl } from '../../checkpoint/control';
import type { EntityRulesControl } from '../../entity_rules/control';
import type { RunnerControl } from '../../runner/control';
import type { TabsControl } from './tabs';
import type { McpControl } from '../../mcp/control';

export type WorkspaceRouterInput = {
    action: Action;
    workspace: RuntimeWorkspace;
    workspaceRegistry: WorkspaceRegistry;
};

export type WorkspaceRouterDeps = {
    tabsControl: TabsControl;
    recordControl: RecordControl;
    dslControl: DslControl;
    checkpointControl: CheckpointControl;
    entityRulesControl: EntityRulesControl;
    runnerControl: RunnerControl;
    mcpControl: McpControl;
};

export type WorkspaceRouter = {
    handle: (action: Action, workspace: RuntimeWorkspace, workspaceRegistry: WorkspaceRegistry) => Promise<ControlPlaneResult>;
};

export const createWorkspaceRouter = (deps: WorkspaceRouterDeps): WorkspaceRouter => ({
    handle: async (action, workspace, workspaceRegistry) => {
        if (action.type.startsWith('tab.')) {
            return await deps.tabsControl.handle({ action, workspace, workspaceRegistry });
        }

        if (action.type.startsWith('record.') || action.type.startsWith('play.')) {
            return await deps.recordControl.handle({ action, workspace, workspaceRegistry });
        }

        if (action.type.startsWith('dsl.')) {
            return await deps.dslControl.handle({ action, workspace, workspaceRegistry });
        }

        if (action.type.startsWith('checkpoint.')) {
            return await deps.checkpointControl.handle({ action, workspace, workspaceRegistry });
        }

        if (action.type.startsWith('entity_rules.')) {
            return await deps.entityRulesControl.handle({ action, workspace, workspaceRegistry });
        }

        if (action.type.startsWith('task.run.')) {
            return await deps.runnerControl.handle({ action, workspace, workspaceRegistry });
        }

        if (action.type.startsWith('mcp.')) {
            return await deps.mcpControl.handle({ action, workspace, workspaceRegistry });
        }

        throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
    },
});
