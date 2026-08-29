import type {AgentToolClassification} from '../../tools/policy';

const readTools = new Set([
    'debug.execution',
    'debug.scope',
    'debug.catalog',
    'debug.program',
    'debug.history',
    'debug.explain',
    'debug.recompute',
    'debug.effects',
    'debug.diff',
    'debug.transaction',
    'debug.transaction_diff',
    'debug.rewind_plan',
    'debug.world',
    'debug.refresh',
    'debug.query',
    'debug.compute',
]);

const controlTools = new Set([
    'debug.patch_statement',
    'debug.recompute_effect',
    'debug.cross_barrier',
    'debug.step',
    'debug.continue',
    'debug.abort',
    'debug.commit',
    'debug.savepoint',
    'debug.rollback',
    'debug.rewind',
]);

export const classifyPausedDslDebugToolCall = (name: string): AgentToolClassification =>
    readTools.has(name) ? 'read' : controlTools.has(name) ? 'control' : 'effect';
