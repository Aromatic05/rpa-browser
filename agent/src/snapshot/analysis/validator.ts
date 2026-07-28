import type {
    AnalysisDiagnostic,
    CandidateEvidence,
    InvariantValidationResult,
    ObservationNodeId,
    ObservationPassCounter,
    PageObservation,
    RelationIndex,
    StructuralQuotientView,
    TreeScopeId,
} from '../observation/contracts';

export const validateObservationAnalysis = (
    input: {
        observation: PageObservation;
        relations: RelationIndex;
        candidates?: readonly CandidateEvidence[];
        quotients: readonly StructuralQuotientView[];
    },
    counter?: ObservationPassCounter,
): InvariantValidationResult => {
    const diagnostics: AnalysisDiagnostic[] = [];
    validateCanonicalIndexes(input.observation, diagnostics, counter);
    validateScopes(input.observation, diagnostics, counter);
    validateRelations(input.observation, input.relations, diagnostics, counter);
    validateQuotients(
        input.observation,
        input.relations,
        input.candidates ?? [],
        input.quotients,
        diagnostics,
        counter,
    );
    return {
        ok: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
        diagnostics,
    };
};

const validateCanonicalIndexes = (
    observation: PageObservation,
    diagnostics: AnalysisDiagnostic[],
    counter?: ObservationPassCounter,
) => {
    const requiredIndexes: Array<[string, Readonly<Record<string, unknown>>]> = [
        ['parents', observation.parents],
        ['children', observation.children],
        ['documentOrder', observation.documentOrder],
        ['attributes', observation.attributes],
        ['text', observation.text],
        ['accessibility', observation.accessibility],
        ['runtimeState', observation.runtimeState],
        ['geometry', observation.geometry],
        ['activity', observation.activity],
        ['domIdentity', observation.domIdentity],
        ['layers', observation.layers],
    ];
    const documentOrders = new Map<number, ObservationNodeId>();
    for (const nodeId of Object.keys(observation.nodes)) {
        if (counter) {counter.nodeVisits += 1;}
        const missingIndexes = requiredIndexes
            .filter(([, index]) => !Object.hasOwn(index, nodeId))
            .map(([name]) => name);
        if (missingIndexes.length > 0) {
            diagnostics.push(errorDiagnostic(
                'invariant.canonical-index.missing',
                [nodeId],
                `canonical indexes missing for ${nodeId}: ${missingIndexes.join(', ')}`,
            ));
        }
        const node = observation.nodes[nodeId];
        if (!observation.scopes.scopes[node.scopeId]) {
            diagnostics.push(errorDiagnostic(
                'invariant.node.scope-missing',
                [nodeId],
                `node ${nodeId} references missing scope ${node.scopeId}`,
            ));
        }
        const order = observation.documentOrder[nodeId];
        if (typeof order === 'number') {
            const previous = documentOrders.get(order);
            if (previous) {
                diagnostics.push(errorDiagnostic(
                    'invariant.document-order.duplicate',
                    [previous, nodeId],
                    `document order ${order} is assigned more than once`,
                ));
            } else {
                documentOrders.set(order, nodeId);
            }
        }
        const parentNodeId = observation.parents[nodeId];
        if (parentNodeId) {
            const parent = observation.nodes[parentNodeId];
            if (!parent) {
                diagnostics.push(errorDiagnostic(
                    'invariant.parent.missing',
                    [nodeId, parentNodeId],
                    `parent ${parentNodeId} is missing for ${nodeId}`,
                ));
            } else {
                if (parent.scopeId !== node.scopeId) {
                    diagnostics.push(errorDiagnostic(
                        'invariant.parent-child.scope-crossing',
                        [parentNodeId, nodeId],
                        'DOM parent-child links must not cross tree scopes',
                    ));
                }
                if (!observation.children[parentNodeId]?.includes(nodeId)) {
                    diagnostics.push(errorDiagnostic(
                        'invariant.parent-child.inconsistent',
                        [parentNodeId, nodeId],
                        `parent index and children index disagree for ${nodeId}`,
                    ));
                }
            }
        }
        for (const childNodeId of observation.children[nodeId] ?? []) {
            if (counter) {counter.nodeVisits += 1;}
            const child = observation.nodes[childNodeId];
            if (!child) {
                diagnostics.push(errorDiagnostic(
                    'invariant.child.missing',
                    [nodeId, childNodeId],
                    `child ${childNodeId} is missing for ${nodeId}`,
                ));
                continue;
            }
            if (child.scopeId !== node.scopeId) {
                diagnostics.push(errorDiagnostic(
                    'invariant.parent-child.scope-crossing',
                    [nodeId, childNodeId],
                    'DOM parent-child links must not cross tree scopes',
                ));
            }
            if (observation.parents[childNodeId] !== nodeId) {
                diagnostics.push(errorDiagnostic(
                    'invariant.child-parent.inconsistent',
                    [nodeId, childNodeId],
                    `children index and parent index disagree for ${childNodeId}`,
                ));
            }
        }
        const captureId = observation.domIdentity[nodeId]?.captureId;
        if (captureId && observation.captureIdToNodeId[captureId] !== nodeId) {
            diagnostics.push(errorDiagnostic(
                'invariant.capture-id-index.inconsistent',
                [nodeId],
                `capture identity index does not resolve ${captureId} back to ${nodeId}`,
            ));
        }
    }
    for (const [captureId, nodeId] of Object.entries(observation.captureIdToNodeId)) {
        if (counter) {counter.nodeVisits += 1;}
        if (!observation.nodes[nodeId]) {
            diagnostics.push(errorDiagnostic(
                'invariant.capture-id-index.node-missing',
                [nodeId],
                `capture id ${captureId} references a missing node`,
            ));
        }
    }
};

const validateScopes = (
    observation: PageObservation,
    diagnostics: AnalysisDiagnostic[],
    counter?: ObservationPassCounter,
) => {
    const scopes = observation.scopes.scopes;
    const actualRoots = Object.values(scopes)
        .filter((scope) => !scope.parentScopeId)
        .map((scope) => scope.id)
        .sort();
    const listedRoots = [...observation.scopes.rootScopeIds].sort();
    if (!sameArray(actualRoots, listedRoots)) {
        diagnostics.push(errorDiagnostic(
            'invariant.scope.roots-inconsistent',
            [],
            'rootScopeIds does not match scopes without parents',
        ));
    }
    for (const scope of Object.values(scopes)) {
        if (counter) {counter.nodeVisits += 1;}
        const root = observation.nodes[scope.rootNodeId];
        if (!root) {
            diagnostics.push(errorDiagnostic(
                'invariant.scope.root-missing',
                [],
                `scope ${scope.id} root is missing from node index`,
            ));
        } else if (root.scopeId !== scope.id) {
            diagnostics.push(errorDiagnostic(
                'invariant.scope.root-scope-mismatch',
                [scope.rootNodeId],
                `scope ${scope.id} root belongs to ${root.scopeId}`,
            ));
        }
        if (scope.parentScopeId) {
            const parentScope = scopes[scope.parentScopeId];
            if (!parentScope) {
                diagnostics.push(errorDiagnostic(
                    'invariant.scope.parent-missing',
                    [],
                    `scope ${scope.id} references missing parent ${scope.parentScopeId}`,
                ));
            }
            if (!scope.hostNodeId) {
                diagnostics.push(errorDiagnostic(
                    'invariant.scope.host-required',
                    [],
                    `nested scope ${scope.id} has no host`,
                ));
            } else {
                const host = observation.nodes[scope.hostNodeId];
                if (!host) {
                    diagnostics.push(errorDiagnostic(
                        'invariant.scope.host-missing',
                        [scope.hostNodeId],
                        `scope ${scope.id} host is missing from node index`,
                    ));
                } else if (parentScope && host.scopeId !== parentScope.id) {
                    diagnostics.push(errorDiagnostic(
                        'invariant.scope.host-parent-mismatch',
                        [scope.hostNodeId],
                        `scope ${scope.id} host is not in parent scope ${parentScope.id}`,
                    ));
                }
            }
        }
        if (scope.status === 'unavailable' && scope.completeness.dom !== 'unavailable') {
            diagnostics.push(errorDiagnostic(
                'invariant.scope.unavailable-completeness',
                [scope.rootNodeId],
                `unavailable scope ${scope.id} reports DOM completeness ${scope.completeness.dom}`,
            ));
        }
    }
    const state = new Map<TreeScopeId, 'visiting' | 'done'>();
    const visit = (scopeId: TreeScopeId): boolean => {
        if (counter) {counter.nodeVisits += 1;}
        if (state.get(scopeId) === 'visiting') {return true;}
        if (state.get(scopeId) === 'done') {return false;}
        state.set(scopeId, 'visiting');
        const parentScopeId = scopes[scopeId]?.parentScopeId;
        const cycle = Boolean(parentScopeId && scopes[parentScopeId] && visit(parentScopeId));
        state.set(scopeId, 'done');
        return cycle;
    };
    for (const scopeId of Object.keys(scopes)) {
        if (visit(scopeId)) {
            diagnostics.push(errorDiagnostic(
                'invariant.scope.cycle',
                [],
                `scope forest contains a cycle at ${scopeId}`,
            ));
            break;
        }
    }
};

const validateRelations = (
    observation: PageObservation,
    relations: RelationIndex,
    diagnostics: AnalysisDiagnostic[],
    counter?: ObservationPassCounter,
) => {
    const seenEdges = new Set<string>();
    relations.edges.forEach((edge, edgeIndex) => {
        if (counter) {counter.edgeVisits += 1;}
        const source = observation.nodes[edge.sourceNodeId];
        if (!source) {
            diagnostics.push(errorDiagnostic(
                'invariant.relation.source-missing',
                [edge.sourceNodeId],
                `relation ${edge.kind} source is missing`,
            ));
            return;
        }
        if (!relations.bySourceNodeId[edge.sourceNodeId]?.includes(edgeIndex)) {
            diagnostics.push(errorDiagnostic(
                'invariant.relation.source-index-missing',
                [edge.sourceNodeId],
                `relation edge ${edgeIndex} is absent from its source index`,
            ));
        }
        if (edge.status === 'resolved' && edge.targetNodeIds.length === 0) {
            diagnostics.push(errorDiagnostic(
                'invariant.relation.resolved-without-target',
                [edge.sourceNodeId],
                `resolved relation ${edge.kind} has no target`,
            ));
        }
        if (edge.status === 'ambiguous' && edge.targetNodeIds.length < 2) {
            diagnostics.push(errorDiagnostic(
                'invariant.relation.ambiguous-without-candidates',
                [edge.sourceNodeId, ...edge.targetNodeIds],
                `ambiguous relation ${edge.kind} has fewer than two targets`,
            ));
        }
        for (const targetNodeId of edge.targetNodeIds) {
            if (counter) {counter.nodeVisits += 1;}
            const target = observation.nodes[targetNodeId];
            if (!target) {
                diagnostics.push(errorDiagnostic(
                    'invariant.relation.target-missing',
                    [edge.sourceNodeId, targetNodeId],
                    `relation ${edge.kind} target is missing`,
                ));
                continue;
            }
            if (!relations.byTargetNodeId[targetNodeId]?.includes(edgeIndex)) {
                diagnostics.push(errorDiagnostic(
                    'invariant.relation.target-index-missing',
                    [edge.sourceNodeId, targetNodeId],
                    `relation edge ${edgeIndex} is absent from target index ${targetNodeId}`,
                ));
            }
            if (SCOPE_LOCAL_RELATIONS.has(edge.kind) && target.scopeId !== source.scopeId) {
                diagnostics.push(errorDiagnostic(
                    'invariant.relation.scope-invalid',
                    [edge.sourceNodeId, targetNodeId],
                    `relation ${edge.kind} crossed tree scopes without platform permission`,
                ));
            }
        }
        const edgeKey = `${edge.kind}:${edge.sourceNodeId}:${edge.status}:${[...edge.targetNodeIds].sort().join(',')}`;
        if (seenEdges.has(edgeKey)) {
            diagnostics.push(errorDiagnostic(
                'invariant.relation.duplicate',
                [edge.sourceNodeId, ...edge.targetNodeIds],
                `duplicate relation edge ${edgeKey}`,
            ));
        }
        seenEdges.add(edgeKey);
    });
    validateRelationIndexDirection(relations, 'source', diagnostics, counter);
    validateRelationIndexDirection(relations, 'target', diagnostics, counter);
};

const validateRelationIndexDirection = (
    relations: RelationIndex,
    direction: 'source' | 'target',
    diagnostics: AnalysisDiagnostic[],
    counter?: ObservationPassCounter,
) => {
    const index = direction === 'source' ? relations.bySourceNodeId : relations.byTargetNodeId;
    for (const [nodeId, edgeIndexes] of Object.entries(index)) {
        for (const edgeIndex of edgeIndexes) {
            if (counter) {counter.edgeVisits += 1;}
            const edge = relations.edges[edgeIndex];
            const valid = direction === 'source'
                ? edge?.sourceNodeId === nodeId
                : edge?.targetNodeIds.includes(nodeId);
            if (!valid) {
                diagnostics.push(errorDiagnostic(
                    `invariant.relation.${direction}-index-invalid`,
                    [nodeId],
                    `${direction} relation index ${nodeId} references invalid edge ${edgeIndex}`,
                ));
            }
        }
    }
};

const validateQuotients = (
    observation: PageObservation,
    relations: RelationIndex,
    candidates: readonly CandidateEvidence[],
    quotients: readonly StructuralQuotientView[],
    diagnostics: AnalysisDiagnostic[],
    counter?: ObservationPassCounter,
) => {
    const candidateByAnchor = new Map(candidates.map((candidate) => [candidate.anchorNodeId, candidate] as const));
    for (const quotient of quotients) {
        const anchor = observation.nodes[quotient.candidateAnchorNodeId];
        const candidate = candidateByAnchor.get(quotient.candidateAnchorNodeId);
        if (!anchor) {
            diagnostics.push(errorDiagnostic(
                'invariant.quotient.anchor-node-missing',
                [quotient.candidateAnchorNodeId],
                'quotient anchor is missing from canonical nodes',
            ));
            continue;
        }
        if (!candidate) {
            diagnostics.push(errorDiagnostic(
                'invariant.quotient.candidate-missing',
                [quotient.candidateAnchorNodeId],
                'quotient anchor has no CandidateEvidence',
            ));
        }
        if (quotient.scopeId !== anchor.scopeId || (candidate && quotient.scopeId !== candidate.scopeId)) {
            diagnostics.push(errorDiagnostic(
                'invariant.quotient.scope-mismatch',
                [quotient.candidateAnchorNodeId],
                'quotient scope does not match its anchor candidate',
            ));
        }
        const retainedNodeIds = new Set<ObservationNodeId>();
        for (const quotientNode of quotient.nodes) {
            if (counter) {counter.nodeVisits += 1;}
            if (retainedNodeIds.has(quotientNode.nodeId)) {
                diagnostics.push(errorDiagnostic(
                    'invariant.quotient.node-duplicate',
                    [quotientNode.nodeId],
                    'quotient retains the same node more than once',
                ));
            }
            retainedNodeIds.add(quotientNode.nodeId);
        }
        if (!retainedNodeIds.has(quotient.candidateAnchorNodeId)) {
            diagnostics.push(errorDiagnostic(
                'invariant.quotient.anchor-missing',
                [quotient.candidateAnchorNodeId],
                'candidate-local quotient does not retain its anchor',
            ));
        }
        for (const quotientNode of quotient.nodes) {
            const node = observation.nodes[quotientNode.nodeId];
            if (!node) {
                diagnostics.push(errorDiagnostic(
                    'invariant.quotient.node-missing',
                    [quotientNode.nodeId],
                    'quotient retained node is missing from canonical node index',
                ));
                continue;
            }
            if (quotientNode.projectionParentId && !retainedNodeIds.has(quotientNode.projectionParentId)) {
                diagnostics.push(errorDiagnostic(
                    'invariant.quotient.orphan',
                    [quotientNode.nodeId, quotientNode.projectionParentId],
                    'quotient projection parent is not retained',
                ));
            }
            const internal = isAncestorOrSelf(
                observation,
                quotient.candidateAnchorNodeId,
                quotientNode.nodeId,
                counter,
            );
            if (!internal && !isRelatedExternalEndpoint(
                observation,
                relations,
                quotient.candidateAnchorNodeId,
                quotientNode.nodeId,
                counter,
            )) {
                diagnostics.push(errorDiagnostic(
                    'invariant.quotient.external-node-unjustified',
                    [quotient.candidateAnchorNodeId, quotientNode.nodeId],
                    'external quotient node is not justified by a relation endpoint',
                ));
            }
            if (internal && quotientNode.nodeId !== quotient.candidateAnchorNodeId) {
                const expected = expectedProjection(observation, quotientNode.nodeId, retainedNodeIds, counter);
                if (quotientNode.projectionParentId !== expected.parentId
                    || !sameArray(quotientNode.collapsedAncestorIds, expected.collapsed)) {
                    diagnostics.push(errorDiagnostic(
                        'invariant.quotient.projection-invalid',
                        [quotientNode.nodeId],
                        'quotient projection provenance does not match canonical ancestry',
                    ));
                }
            }
        }
        if (hasProjectionCycle(quotient.nodes, counter)) {
            diagnostics.push(errorDiagnostic(
                'invariant.quotient.cycle',
                [quotient.candidateAnchorNodeId],
                'quotient projection parent contains a cycle',
            ));
        }
    }
};

const expectedProjection = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    retainedNodeIds: ReadonlySet<ObservationNodeId>,
    counter?: ObservationPassCounter,
): { parentId?: ObservationNodeId; collapsed: ObservationNodeId[] } => {
    const collapsed: ObservationNodeId[] = [];
    let cursor = observation.parents[nodeId];
    while (cursor) {
        if (counter) {counter.nodeVisits += 1;}
        if (retainedNodeIds.has(cursor)) {return { parentId: cursor, collapsed };}
        collapsed.push(cursor);
        cursor = observation.parents[cursor];
    }
    return { collapsed };
};

const isRelatedExternalEndpoint = (
    observation: PageObservation,
    relations: RelationIndex,
    anchorNodeId: ObservationNodeId,
    externalNodeId: ObservationNodeId,
    counter?: ObservationPassCounter,
): boolean => {
    const edgeIndexes = new Set([
        ...(relations.bySourceNodeId[externalNodeId] ?? []),
        ...(relations.byTargetNodeId[externalNodeId] ?? []),
    ]);
    for (const edgeIndex of edgeIndexes) {
        if (counter) {counter.edgeVisits += 1;}
        const edge = relations.edges[edgeIndex];
        if (!edge) {continue;}
        const otherNodeIds = [edge.sourceNodeId, ...edge.targetNodeIds]
            .filter((nodeId) => nodeId !== externalNodeId);
        if (otherNodeIds.some((nodeId) => isAncestorOrSelf(observation, anchorNodeId, nodeId, counter))) {
            return true;
        }
    }
    return false;
};

const isAncestorOrSelf = (
    observation: PageObservation,
    ancestorNodeId: ObservationNodeId,
    nodeId: ObservationNodeId,
    counter?: ObservationPassCounter,
): boolean => {
    let cursor: ObservationNodeId | undefined = nodeId;
    const visited = new Set<ObservationNodeId>();
    while (cursor && !visited.has(cursor)) {
        if (counter) {counter.nodeVisits += 1;}
        if (cursor === ancestorNodeId) {return true;}
        visited.add(cursor);
        cursor = observation.parents[cursor];
    }
    return false;
};

const hasProjectionCycle = (
    nodes: readonly { nodeId: ObservationNodeId; projectionParentId?: ObservationNodeId }[],
    counter?: ObservationPassCounter,
): boolean => {
    const parentByNodeId = new Map(nodes.map((node) => [node.nodeId, node.projectionParentId] as const));
    const state = new Map<ObservationNodeId, 'visiting' | 'done'>();
    const visit = (nodeId: ObservationNodeId): boolean => {
        if (counter) {counter.nodeVisits += 1;}
        if (state.get(nodeId) === 'visiting') {return true;}
        if (state.get(nodeId) === 'done') {return false;}
        state.set(nodeId, 'visiting');
        const parentId = parentByNodeId.get(nodeId);
        const cycle = Boolean(parentId && parentByNodeId.has(parentId) && visit(parentId));
        state.set(nodeId, 'done');
        return cycle;
    };
    return nodes.some((node) => visit(node.nodeId));
};

const sameArray = <T>(left: readonly T[], right: readonly T[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index]);

const errorDiagnostic = (
    code: string,
    nodeIds: ObservationNodeId[],
    message: string,
): AnalysisDiagnostic => ({
    code,
    severity: 'error',
    stage: 'invariant',
    nodeIds,
    evidence: [],
    message,
});

const SCOPE_LOCAL_RELATIONS = new Set([
    'labelled-by', 'label-for', 'described-by', 'error-message', 'controls-target', 'popup-owner', 'owns', 'form-owner',
]);
