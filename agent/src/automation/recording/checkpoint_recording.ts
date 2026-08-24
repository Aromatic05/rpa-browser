import {ActionError, ERROR_CODES} from '../../interface/actions/results';
import type {WorkspaceRouterInput} from '../../runtime/workspace/router';
import type {StepUnion} from '../runner/steps/types';
import type {WorkflowCheckpoint} from '../workflow';
import type {RecordingEnhancementMap} from './types';
import {buildRecordedProcedureCheckpoint} from './checkpoint/procedure';
import {buildRecordedRecoveryCheckpoint} from './checkpoint/recovery';
import type {CheckpointRecordSavePayload} from './checkpoint/types';

export type * from './checkpoint/types';
export {checkpointEntityRuleOptions, requireCheckpointEntityRuleOption} from './checkpoint/options';
export {checkpointStepSummary} from './checkpoint/summary';

export const buildRecordedCheckpoint = (
    workspace: WorkspaceRouterInput['workspace'],
    steps: readonly StepUnion[],
    enrichments: RecordingEnhancementMap,
    payload: CheckpointRecordSavePayload,
): WorkflowCheckpoint => {
    if (!steps.length) {
        throw new ActionError(ERROR_CODES.ERR_RECORDING_EMPTY, '没有录制到检查点操作');
    }
    return payload.kind === 'procedure'
        ? buildRecordedProcedureCheckpoint(workspace, steps, enrichments, payload)
        : buildRecordedRecoveryCheckpoint(workspace, steps, enrichments, payload);
};
