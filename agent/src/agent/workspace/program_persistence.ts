import type {RunStepsDeps} from '../../automation/runner/run_steps';
import {createDslEntityRulesResolver} from '../../automation/dsl/link';
import {saveWorkflowDsl} from '../../automation/dsl/save';
import {workflowArtifactRevision} from '../../automation/workflow';
import {WorkflowError} from '../../automation/workflow/errors';
import type {
    AgentProgramSaveRequest,
    AgentProgramSaveResult,
    AgentProgramSaver,
} from '../execution/program/persistence';

export type CreateWorkspaceProgramSaverOptions = Readonly<{
    workspaceName: string;
    deps: RunStepsDeps;
}>;

export const createWorkspaceProgramSaver = (
    options: CreateWorkspaceProgramSaverOptions,
): AgentProgramSaver => async (request) => {
    const workspace = options.deps.resolveWorkspace(options.workspaceName);
    const workflow = workspace.workflow;
    const currentRevision = readCurrentRevision(workflow, request.name);
    if (currentRevision !== null && request.expectedRevision === undefined) {
        return conflict(request, currentRevision);
    }
    const expectedRevision = request.expectedRevision === undefined
        ? null
        : request.expectedRevision;
    try {
        const saved = saveWorkflowDsl({
            workflow,
            checkpointProvider: workspace.checkpoint.getProvider(workflow),
            entityRulesResolver: createDslEntityRulesResolver(workspace.entityRules.getProvider(workflow)),
            dslName: request.name,
            content: request.source,
            expectedRevision,
        });
        return {
            status: 'saved',
            name: saved.name,
            artifactRevision: workflowArtifactRevision(saved),
        };
    } catch (error) {
        if (error instanceof WorkflowError && error.code === 'ERR_CONFLICT') {
            return conflict(request, readCurrentRevision(workflow, request.name));
        }
        throw error;
    }
};

const readCurrentRevision = (
    workflow: ReturnType<RunStepsDeps['resolveWorkspace']>['workflow'],
    name: string,
): string | null => {
    const artifact = workflow.get(name, {kind: 'dsl'});
    return artifact?.kind === 'dsl' ? workflowArtifactRevision(artifact) : null;
};

const conflict = (
    request: AgentProgramSaveRequest,
    currentRevision: string | null,
): AgentProgramSaveResult => ({
    status: 'conflict',
    name: request.name,
    currentRevision,
});
