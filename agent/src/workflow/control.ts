import { ActionError } from '../actions/results';
import { ERROR_CODES } from '../actions/results';
import type { WorkspaceRouterInput } from '../runtime/workspace/router';
import type { ControlPlaneResult } from '../runtime/control_plane';
import type { RecordingState } from '../record/recording';

export type WorkflowControlServices = {
    recordingState: RecordingState;
};

export type WorkflowControl = {
    handle: (input: WorkspaceRouterInput) => Promise<ControlPlaneResult>;
};

export const createWorkflowControl = (_services: WorkflowControlServices): WorkflowControl => ({
    handle: async (input) => {
        throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${input.action.type}`);
    },
});
