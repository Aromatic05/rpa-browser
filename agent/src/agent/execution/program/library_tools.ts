import {Type} from '@earendil-works/pi-ai';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import type {AgentProgramLibrary} from './library';

export const LIST_PROGRAMS_TOOL = 'agent.list_programs';
export const LOAD_PROGRAM_TOOL = 'agent.load_program';

const toolResult = (details: unknown) => ({
    content: [{type: 'text' as const, text: JSON.stringify(details)}],
    details,
});

export const createProgramLibraryTools = (
    library: AgentProgramLibrary,
): readonly AgentTool[] => [
    {
        name: LIST_PROGRAMS_TOOL,
        label: LIST_PROGRAMS_TOOL,
        description: 'List persisted workspace DSL Programs. This is a read-only artifact catalog operation.',
        parameters: Type.Object({}, {additionalProperties: false}),
        execute: async () => toolResult({programs: await library.list()}),
    },
    {
        name: LOAD_PROGRAM_TOOL,
        label: LOAD_PROGRAM_TOOL,
        description: 'Load one persisted workspace DSL Program for inspection or editing. Returns source, artifactRevision for CAS save, and resolve sidecar symbol names. This never executes or modifies the Program.',
        parameters: Type.Object({
            name: Type.String({minLength: 1}),
        }, {additionalProperties: false}),
        execute: async (_toolCallId, params) => {
            const input = params as {name: string};
            return toolResult(await library.load(input.name.trim()));
        },
    },
];
