import type {AgentToolClassification} from '../../tools/policy';

const readTools = new Set([
    'debug.execution',
    'debug.scope',
    'debug.effects',
    'debug.diff',
    'debug.world',
    'debug.refresh',
    'debug.query',
    'debug.compute',
]);

const controlTools = new Set([
    'debug.step',
    'debug.continue',
    'debug.abort',
]);

export const classifyPausedDslDebugToolCall = (name: string): AgentToolClassification =>
    readTools.has(name) ? 'read' : controlTools.has(name) ? 'control' : 'effect';
