import { parseDsl } from './parser';
import type { DslStmt } from './ast/types';

export type DslAssetReferences = {
    resolveBundles: Set<string>;
    entityRuleProfiles: Set<string>;
    checkpoints: Set<string>;
};

export const scanDslAssetReferences = (source: string): DslAssetReferences => {
    const program = parseDsl(source);
    const references: DslAssetReferences = {
        resolveBundles: new Set(), entityRuleProfiles: new Set(), checkpoints: new Set(),
    };
    for (const imported of program.imports || []) {
        if (imported.kind === 'resolves') {references.resolveBundles.add(imported.bundleName);}
        if (imported.kind === 'entity_rules') {references.entityRuleProfiles.add(imported.profileName);}
    }
    collectCheckpointReferences(program.body, references.checkpoints);
    return references;
};

const collectCheckpointReferences = (body: readonly DslStmt[], checkpoints: Set<string>): void => {
    for (const stmt of body) {
        if (stmt.kind === 'checkpoint') {checkpoints.add(stmt.id);}
        if (stmt.kind === 'if') {
            collectCheckpointReferences(stmt.then, checkpoints);
            collectCheckpointReferences(stmt.else || [], checkpoints);
        }
        if (stmt.kind === 'for') {collectCheckpointReferences(stmt.body, checkpoints);}
    }
};
