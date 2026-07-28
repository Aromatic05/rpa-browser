import type { ObservationNodeId, PageObservation } from './contracts';

export const buildBackendSelectorMapFromObservation = (
    observation: PageObservation,
): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const scope of Object.values(observation.scopes.scopes)) {
        walkScope(observation, scope.rootNodeId, undefined, result);
    }
    return result;
};

const walkScope = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    parentPath: string | undefined,
    output: Record<string, string>,
) => {
    const node = observation.nodes[nodeId];
    if (!node) {return;}
    const tag = normalizeTag(node.tag);
    const currentPath = tag
        ? appendPath(parentPath, `${tag}:nth-of-type(${computeNthOfType(observation, nodeId, tag)})`)
        : parentPath;
    const backendNodeId = observation.domIdentity[nodeId]?.backendNodeId;
    if (backendNodeId && currentPath) {
        output[backendNodeId] = currentPath;
    }
    for (const childNodeId of observation.children[nodeId] ?? []) {
        walkScope(observation, childNodeId, currentPath, output);
    }
};

const computeNthOfType = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    tag: string,
): number => {
    const parentNodeId = observation.parents[nodeId];
    if (!parentNodeId) {return 1;}
    let position = 0;
    for (const siblingNodeId of observation.children[parentNodeId] ?? []) {
        if (normalizeTag(observation.nodes[siblingNodeId]?.tag) !== tag) {continue;}
        position += 1;
        if (siblingNodeId === nodeId) {return position;}
    }
    return 1;
};

const appendPath = (parentPath: string | undefined, segment: string): string =>
    parentPath ? `${parentPath} > ${segment}` : segment;
const normalizeTag = (value: string | undefined): string => {
    const normalized = (value ?? '').trim().toLowerCase();
    return normalized && !normalized.startsWith('#') ? normalized : '';
};
