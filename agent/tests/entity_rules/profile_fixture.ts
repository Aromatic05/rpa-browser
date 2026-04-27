import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TEST_PROFILES_DIR = path.resolve(process.cwd(), 'tests/entity_rules/profiles');

export type EntityRuleFixtureRoot = {
    rootDir: string;
    cleanup: () => Promise<void>;
};

export const createEntityRuleFixtureRoot = async (): Promise<EntityRuleFixtureRoot> => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'entity-rules-fixture-'));
    const targetProfilesDir = path.join(rootDir, 'profiles');
    await fs.mkdir(targetProfilesDir, { recursive: true });
    await fs.cp(TEST_PROFILES_DIR, targetProfilesDir, { recursive: true });

    return {
        rootDir,
        cleanup: async () => {
            await fs.rm(rootDir, { recursive: true, force: true });
        },
    };
};
