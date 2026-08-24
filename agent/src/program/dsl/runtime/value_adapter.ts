import type { BrowserQueryResult } from '../../../automation/runner/steps/types';

export type DslTargetRef = {
    nodeId: string;
    meta?: Record<string, unknown>;
};

export const adaptDslQueryResult = (result: BrowserQueryResult): unknown => {
    if (result.kind === 'value') {return result.value;}
    if (result.kind === 'nodeId') {
        return result.meta ? { nodeId: result.nodeId, meta: result.meta } : { nodeId: result.nodeId };
    }
    return result.nodeIds.map((nodeId) => result.meta ? { nodeId, meta: result.meta } : { nodeId });
};
