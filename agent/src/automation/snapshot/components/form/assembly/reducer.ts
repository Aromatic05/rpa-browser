import type {
    ObservationNodeId,
    PageObservation,
} from '../../../observation/model/contracts';
import type { BottomUpReducer, ReductionContext } from '../model/contracts';

export const reduceBottomUp = <T>(
    observation: PageObservation,
    reducer: BottomUpReducer<T>,
    createEmpty: () => T,
): T[] => observation.scopes.rootScopeIds.map((scopeId) => {
    const rootNodeId = observation.scopes.scopes[scopeId].rootNodeId;
    return rootNodeId ? reduceNode(observation, rootNodeId, reducer) : createEmpty();
});

const reduceNode = <T>(
    observation: PageObservation,
    nodeId: ObservationNodeId,
    reducer: BottomUpReducer<T>,
): T => {
    const children = (observation.children[nodeId] ?? [])
        .map((childNodeId) => reduceNode(observation, childNodeId, reducer));
    const context: ReductionContext = { observation };
    return reducer(nodeId, children, context);
};
