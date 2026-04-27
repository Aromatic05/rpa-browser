import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createEntityRuleFixtureRoot } from '../entity_rules/profile_fixture';

test('entity rule fixture helper copies test profiles into temporary rootDir', async () => {
    const fixture = await createEntityRuleFixtureRoot();
    try {
        const targetProfileDir = path.join(fixture.rootDir, 'profiles', 'oa-ant-orders');
        const stat = await fs.stat(targetProfileDir);
        assert.equal(stat.isDirectory(), true);

        const matchYaml = await fs.readFile(path.join(targetProfileDir, 'match.yaml'), 'utf-8');
        assert.equal(matchYaml.includes('entities:'), true);
    } finally {
        await fixture.cleanup();
    }
});
