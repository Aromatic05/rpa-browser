import type {
    AssetValidationEvidence,
    DependencyHealth,
    LibraryAssetEvidenceDependency,
} from './contracts';

export const computeHealth = (options: {
    assetRevision: string | null;
    dependencies: readonly LibraryAssetEvidenceDependency[];
    evidence: AssetValidationEvidence | null;
}): DependencyHealth => {
    const {assetRevision, dependencies, evidence} = options;
    if (!evidence) {return 'unknown';}
    if (evidence.assetRevision !== assetRevision) {return 'needs_review';}
    if (!evidenceMatchesDependencies(evidence.dependencies, dependencies)) {return 'needs_review';}
    return evidence.outcome === 'ready' ? 'ready' : 'broken';
};

const evidenceMatchesDependencies = (
    recorded: readonly LibraryAssetEvidenceDependency[],
    current: readonly LibraryAssetEvidenceDependency[],
): boolean => {
    if (recorded.length !== current.length) {return false;}
    return current.every((dependency) => {
        const match = recorded.find((item) =>
            item.kind === dependency.kind && item.name === dependency.name);
        return match?.revision === dependency.revision;
    });
};