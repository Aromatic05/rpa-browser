import type {RunStepsDeps} from '../../automation/runner/run_steps';
import {workflowArtifactRevision} from '../../automation/workflow';
import type {
    AgentProgramCatalogItem,
    AgentProgramLibrary,
    AgentProgramLoadResult,
} from '../execution/program/library';

export type CreateWorkspaceProgramLibraryOptions = Readonly<{
    workspaceName: string;
    deps: RunStepsDeps;
}>;

export const createWorkspaceProgramLibrary = (
    options: CreateWorkspaceProgramLibraryOptions,
): AgentProgramLibrary => ({
    list: async () => {
        const workflow = options.deps.resolveWorkspace(options.workspaceName).workflow;
        return workflow.list({kind: 'dsl'})
            .map((item): AgentProgramCatalogItem => Object.freeze({
                name: item.name,
                title: item.title,
                summary: item.summary,
                updatedAt: item.updatedAt,
            }))
            .sort((left, right) => left.name.localeCompare(right.name));
    },
    load: async (name): Promise<AgentProgramLoadResult> => {
        const workflow = options.deps.resolveWorkspace(options.workspaceName).workflow;
        const artifact = workflow.get(name, {kind: 'dsl'});
        if (artifact?.kind !== 'dsl') {return {status: 'not_found', name};}
        return {
            status: 'loaded',
            program: {
                name: artifact.name,
                source: artifact.content,
                artifactRevision: workflowArtifactRevision(artifact),
                resolveSymbols: Object.freeze(Object.keys(artifact.stepResolves).sort()),
            },
        };
    },
});
