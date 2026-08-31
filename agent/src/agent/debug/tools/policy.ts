import type {AgentToolClassification} from '../../tools/policy';

export const DEBUG_QUERY_TOOL_NAMES = [
    'debug.world',
    'debug.query',
    'debug.compute',
] as const;

export type DebugQueryToolName = (typeof DEBUG_QUERY_TOOL_NAMES)[number];

const debugToolNames = new Set<string>(DEBUG_QUERY_TOOL_NAMES);

export const classifyDebugQueryToolCall = (name: string): AgentToolClassification =>
    debugToolNames.has(name) ? 'read' : 'effect';
