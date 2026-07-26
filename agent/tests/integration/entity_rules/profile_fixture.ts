import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { WorkflowEntityRules } from '../../../src/workflow';

const FIXTURE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEST_PROFILES_DIR = path.join(FIXTURE_ROOT, 'profiles');
const TEST_WORKFLOWS_DIR = path.join(FIXTURE_ROOT, 'workflows');

export const entityRuleProfileDir = (profile: string): string => path.join(TEST_PROFILES_DIR, profile);

export const loadEntityRuleArtifact = async (profile: string): Promise<WorkflowEntityRules> => {
    const profileDir = entityRuleProfileDir(profile);
    const [matchSource, annotationSource] = await Promise.all([
        fs.readFile(path.join(profileDir, 'match.yaml'), 'utf8'),
        fs.readFile(path.join(profileDir, 'annotation.yaml'), 'utf8'),
    ]);
    return {
        kind: 'entity_rules',
        name: profile,
        match: parse(matchSource),
        annotation: parse(annotationSource),
    };
};

export type EntityRuleFixtureRoot = {
    rootDir: string;
    cleanup: () => Promise<void>;
};

export const createEntityRuleFixtureRoot = async (): Promise<EntityRuleFixtureRoot> => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'entity-rules-fixture-'));
    const targetProfilesDir = path.join(rootDir, 'entity_rules', 'profiles');
    const targetWorkflowsDir = path.join(rootDir, 'workflows');
    await fs.mkdir(targetProfilesDir, { recursive: true });
    await fs.mkdir(targetWorkflowsDir, { recursive: true });
    await fs.cp(TEST_PROFILES_DIR, targetProfilesDir, { recursive: true });
    await fs.cp(TEST_WORKFLOWS_DIR, targetWorkflowsDir, { recursive: true });

    return {
        rootDir,
        cleanup: async () => {
            await fs.rm(rootDir, { recursive: true, force: true });
        },
    };
};
