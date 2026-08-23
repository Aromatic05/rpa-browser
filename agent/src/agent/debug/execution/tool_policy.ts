import type {AgentToolClassification} from '../../tools/policy';

const readTools = new Set([
    'debug.execution',
    'debug.scope',
    'debug.world',
    'debug.query',
    'debug.compute',
]);

export const classifyPausedDslDebugToolCall = (name: string): AgentToolClassification =>
    readTools.has(name) ? 'read' : 'effect';
