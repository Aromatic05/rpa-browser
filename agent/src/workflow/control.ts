import { ActionError } from '../actions/results';
import { ERROR_CODES } from '../actions/results';
import type { WorkspaceRouterInput } from '../runtime/workspace/router';
import type { ControlPlaneResult } from '../runtime/control_plane';
import type { RecordingState } from '../record/recording';
import { copyWorkflowOnFs, listWorkflowNames, loadWorkflowFromFs } from './index';
import { replyAction, type Action } from '../actions/action_protocol';
import crypto from 'node:crypto';

export type WorkflowControlServices = {
    recordingState: RecordingState;
};

export type WorkflowControl = {
    handle: (input: WorkspaceRouterInput) => Promise<ControlPlaneResult>;
};

export const createWorkflowControl = (_services: WorkflowControlServices): WorkflowControl => ({
    handle: async (input) => {
        const { action, workspace, workspaceRegistry } = input;
        if (action.type === 'workflow.saveAs') {
            const sourceName = (action.workspaceName || '').trim();
            const payload = (action.payload || {}) as { targetName?: string };
            const targetName = (payload.targetName || '').trim();
            if (!sourceName) {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'workflow.saveAs requires source workspaceName');
            }
            if (!targetName) {
                throw new ActionError(ERROR_CODES.ERR_WORKFLOW_BAD_ARGS, 'targetName is required');
            }
            if (targetName === sourceName) {
                throw new ActionError(ERROR_CODES.ERR_WORKFLOW_BAD_ARGS, 'targetName must be different from sourceName');
            }
            if (!workspace || workspace.name !== sourceName) {
                throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, `workspace not found: ${sourceName}`);
            }
            if (listWorkflowNames().includes(targetName)) {
                throw new ActionError(ERROR_CODES.ERR_WORKFLOW_BAD_ARGS, `workflow already exists: ${targetName}`);
            }

            copyWorkflowOnFs(sourceName, targetName);
            const targetWorkflow = loadWorkflowFromFs(targetName);
            const targetWorkspace = workspaceRegistry.createWorkspace(targetName, targetWorkflow);
            workspaceRegistry.setActiveWorkspace(targetName);
            const event: Action = {
                v: 1,
                id: crypto.randomUUID(),
                type: 'workspace.changed',
                payload: { workspaceName: targetName, activeWorkspaceName: targetName },
                at: Date.now(),
                traceId: action.traceId,
            };
            return {
                reply: replyAction(action, { sourceName, targetName, workspaceName: targetWorkspace.name, savedAs: true }),
                events: [event],
            };
        }
        throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
    },
});
