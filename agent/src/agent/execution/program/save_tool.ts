import {Type} from '@earendil-works/pi-ai';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import type {AgentProgramSavedArtifact} from '../types';
import type {AgentProgramSaver} from './persistence';
import type {ProgramExecutionToolController} from './tool';

export const SAVE_PROGRAM_TOOL = 'agent.save_program';

type SaveProgramInput = {
    name: string;
    expectedRevision?: string | null;
};

const toolResult = (details: unknown) => ({
    content: [{type: 'text' as const, text: JSON.stringify(details)}],
    details,
});

export type ProgramSaveToolController = Readonly<{
    tool: AgentTool;
    readSaved: () => readonly AgentProgramSavedArtifact[];
}>;

export const createProgramSaveTool = (options: {
    execution: ProgramExecutionToolController;
    save: AgentProgramSaver;
}): ProgramSaveToolController => {
    const saved: AgentProgramSavedArtifact[] = [];
    const tool: AgentTool = {
        name: SAVE_PROGRAM_TOOL,
        label: SAVE_PROGRAM_TOOL,
        description: 'Explicitly persist the completed retained Program as a workspace DSL artifact. The tool always saves the Program materialized from the executed source plus durable patches; source cannot be supplied separately. Existing artifacts require an observed expectedRevision before overwrite.',
        parameters: Type.Object({
            name: Type.String({minLength: 1}),
            expectedRevision: Type.Optional(Type.Union([Type.String({minLength: 1}), Type.Null()])),
        }, {additionalProperties: false}),
        execute: async (_toolCallId, params) => {
            if (!options.execution.hasCompletedProgram()) {
                throw new Error('only a completed retained Program can be saved');
            }
            const source = options.execution.readMaterializedSource();
            if (!source) {throw new Error('completed Program source is unavailable');}
            const input = params as SaveProgramInput;
            const name = input.name.trim();
            if (!name) {throw new Error('Program artifact name is required');}
            const result = await options.save({
                name,
                source,
                ...(input.expectedRevision === undefined
                    ? {}
                    : {expectedRevision: input.expectedRevision}),
            });
            if (result.status === 'saved') {
                saved.push(Object.freeze({
                    name: result.name,
                    artifactRevision: result.artifactRevision,
                }));
            }
            return toolResult(result);
        },
    };
    return {
        tool,
        readSaved: () => Object.freeze(saved.map((item) => structuredClone(item))),
    };
};
