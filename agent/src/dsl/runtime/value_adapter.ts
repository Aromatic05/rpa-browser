import type { BrowserQueryResult } from '../../runner/steps/types';

export const adaptDslQueryResult = (result: BrowserQueryResult): unknown => {
    if (result.kind === 'value') {return result.value;}
    if (result.kind === 'nodeId') {return result.nodeId;}
    return result.nodeIds;
};
