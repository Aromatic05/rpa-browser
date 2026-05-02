import { ActionError } from '../actions/failure';
import { ERROR_CODES } from '../actions/error_codes';
import type { WorkspaceControlInput } from '../runtime/workspace_control';
import type { ControlPlaneResult } from '../runtime/control';

export const handleRunnerControlAction = async (input: WorkspaceControlInput): Promise<ControlPlaneResult> => {
    if (input.action.type.startsWith('task.run.')) {
        throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${input.action.type}`);
    }
    throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${input.action.type}`);
};
