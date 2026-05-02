import { ActionError } from '../actions/failure';
import { ERROR_CODES } from '../actions/error_codes';
import type { WorkspaceControlInput } from '../runtime/workspace_control';
import type { ControlPlaneResult } from '../runtime/control';

export const handleRecordControlAction = async (_input: WorkspaceControlInput): Promise<ControlPlaneResult> => {
    throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${_input.action.type}`);
};
