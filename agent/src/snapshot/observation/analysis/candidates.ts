import type {
    ObservationPassCounter,
    Evidence,
    ObservationNodeId,
    PageObservation,
} from '../model/contracts';
import type {
    CandidateEvidence,
    CandidateKind,
} from './contracts';
import { resolveSemanticRole } from '../model/semantic';

export const classifyCandidates = (
    observation: PageObservation,
    counter?: ObservationPassCounter,
): CandidateEvidence[] => orderedNodeIds(observation).map((nodeId) => {
    if (counter) {counter.nodeVisits += 1;}
    return classifyCandidate(observation, nodeId);
});

const classifyCandidate = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
): CandidateEvidence => {
    const node = observation.nodes[nodeId];
    const attributes = observation.attributes[nodeId] ?? {};
    const role = resolveSemanticRole(observation, nodeId);
    const classTokens = splitClassTokens(attributes.class);
    const facts = observation.activity[nodeId];
    const evidence: Evidence[] = [];

    const structuralKinds = collectStructuralKinds(node.tag, role, evidence, nodeId);
    const hostKinds = collectHostKinds(classTokens, evidence, nodeId);
    const partKinds = collectPartKinds(node.tag, role, classTokens, evidence, nodeId);
    const entityKinds = new Set<CandidateKind>([...structuralKinds, ...hostKinds]);
    const allKinds = new Set<CandidateKind>([...entityKinds, ...partKinds]);
    const kind = allKinds.size === 1 ? [...allKinds][0] : undefined;

    let classification: CandidateEvidence['classification'];
    if (!facts.subtreeActive && allKinds.size > 0) {
        classification = 'latent';
        evidence.push({
            code: 'candidate.activity.latent',
            strength: 'strong',
            source: 'dom',
            nodeIds: [nodeId],
        });
    } else if (entityKinds.size > 1 || hostKinds.size > 1 || structuralKinds.size > 1) {
        classification = 'ambiguous';
        evidence.push({
            code: 'candidate.classification.conflict',
            strength: 'strong',
            source: 'dom',
            nodeIds: [nodeId],
            detail: {
                structuralKinds: [...structuralKinds],
                hostKinds: [...hostKinds],
            },
        });
    } else if (hostKinds.size > 0) {
        classification = 'host';
    } else if (structuralKinds.size > 0) {
        classification = 'structural';
    } else if (partKinds.size > 0) {
        classification = 'part';
    } else {
        classification = 'rejected';
        evidence.push({
            code: 'candidate.no-structural-evidence',
            strength: 'strong',
            source: 'dom',
            nodeIds: [nodeId],
        });
    }

    return {
        anchorNodeId: nodeId,
        scopeId: node.scopeId,
        kind,
        classification,
        evidence,
    };
};

const collectStructuralKinds = (
    tag: string | undefined,
    role: ReturnType<typeof resolveSemanticRole>,
    evidence: Evidence[],
    nodeId: ObservationNodeId,
): Set<CandidateKind> => {
    const kinds = new Set<CandidateKind>();
    const tagKind = STRUCTURAL_TAG_KIND.get(normalize(tag).toLowerCase());
    if (tagKind) {
        kinds.add(tagKind);
        evidence.push({
            code: `candidate.structural.tag.${tagKind}`,
            strength: 'exact',
            source: 'dom',
            nodeIds: [nodeId],
        });
    }
    const roleKind = STRUCTURAL_ROLE_KIND.get(role.value);
    if (roleKind) {
        kinds.add(roleKind);
        evidence.push({
            code: `candidate.structural.role.${roleKind}`,
            strength: role.strength,
            source: role.source,
            nodeIds: [nodeId],
        });
    }
    return kinds;
};

const collectHostKinds = (
    classTokens: ReadonlySet<string>,
    evidence: Evidence[],
    nodeId: ObservationNodeId,
): Set<CandidateKind> => {
    const kinds = new Set<CandidateKind>();
    for (const [classToken, kind] of HOST_CLASS_KIND.entries()) {
        if (!classTokens.has(classToken)) {continue;}
        kinds.add(kind);
        evidence.push({
            code: `candidate.host.class.${kind}`,
            strength: 'strong',
            source: 'dom',
            nodeIds: [nodeId],
            detail: { classToken },
        });
    }
    return kinds;
};

const collectPartKinds = (
    tag: string | undefined,
    role: ReturnType<typeof resolveSemanticRole>,
    classTokens: ReadonlySet<string>,
    evidence: Evidence[],
    nodeId: ObservationNodeId,
): Set<CandidateKind> => {
    const kinds = new Set<CandidateKind>();
    const normalizedTag = normalize(tag).toLowerCase();
    if (PART_TAGS.has(normalizedTag)) {
        kinds.add('part');
        evidence.push({
            code: 'candidate.part.tag',
            strength: 'exact',
            source: 'dom',
            nodeIds: [nodeId],
            detail: { tag: normalizedTag },
        });
    }
    if (PART_ROLES.has(role.value)) {
        kinds.add('part');
        evidence.push({
            code: 'candidate.part.role',
            strength: role.strength,
            source: role.source,
            nodeIds: [nodeId],
            detail: { role: role.value },
        });
    }
    for (const classToken of classTokens) {
        if (!PART_CLASS_TOKENS.has(classToken)) {continue;}
        kinds.add('part');
        evidence.push({
            code: 'candidate.part.class',
            strength: 'strong',
            source: 'dom',
            nodeIds: [nodeId],
            detail: { classToken },
        });
    }
    return kinds;
};

const orderedNodeIds = (observation: PageObservation): ObservationNodeId[] =>
    Object.keys(observation.nodes).sort((left, right) =>
        (observation.documentOrder[left] ?? Number.MAX_SAFE_INTEGER)
        - (observation.documentOrder[right] ?? Number.MAX_SAFE_INTEGER));

const splitClassTokens = (value: string | undefined): Set<string> =>
    new Set(normalize(value).toLowerCase().split(/\s+/).filter(Boolean));
const normalize = (value: string | undefined): string => (value ?? '').trim();

const STRUCTURAL_TAG_KIND = new Map<string, CandidateKind>([
    ['form', 'form'], ['table', 'table'], ['dialog', 'dialog'], ['ul', 'list'], ['ol', 'list'],
]);
const STRUCTURAL_ROLE_KIND = new Map<string, CandidateKind>([
    ['form', 'form'], ['table', 'table'], ['grid', 'table'], ['treegrid', 'table'],
    ['dialog', 'dialog'], ['alertdialog', 'dialog'], ['list', 'list'], ['toolbar', 'toolbar'],
]);
const HOST_CLASS_KIND = new Map<string, CandidateKind>([
    ['el-form', 'form'], ['el-table', 'table'], ['el-dialog', 'dialog'],
    ['ant-form', 'form'], ['ant-table-wrapper', 'table'], ['ant-modal', 'dialog'],
]);
const PART_TAGS = new Set(['thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup']);
const PART_ROLES = new Set(['rowgroup', 'row', 'cell', 'gridcell', 'columnheader', 'rowheader']);
const PART_CLASS_TOKENS = new Set([
    'el-table__header-wrapper', 'el-table__body-wrapper', 'el-table__fixed',
    'el-table__fixed-right', 'ant-table-header', 'ant-table-body', 'ant-table-summary',
]);
