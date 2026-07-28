import type {
    EvidenceSource,
    EvidenceStrength,
    ObservationNodeId,
    PageObservation,
} from './contracts';

export type SemanticRoleResolution = {
    value: string;
    source: EvidenceSource;
    strength: EvidenceStrength;
};

export const resolveSemanticRole = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
): SemanticRoleResolution => {
    const accessibilityRole = normalize(observation.accessibility[nodeId]?.role).toLowerCase();
    if (accessibilityRole) {
        return { value: accessibilityRole, source: 'a11y', strength: 'strong' };
    }
    const domRole = normalize(observation.attributes[nodeId]?.role).toLowerCase();
    if (domRole) {
        return { value: domRole, source: 'dom', strength: 'strong' };
    }
    return {
        value: normalize(observation.nodes[nodeId]?.tag).toLowerCase(),
        source: 'dom',
        strength: 'exact',
    };
};

const normalize = (value: string | undefined): string => (value ?? '').trim();
