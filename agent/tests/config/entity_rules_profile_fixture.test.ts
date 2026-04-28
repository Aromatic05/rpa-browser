import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createEntityRuleFixtureRoot } from '../entity_rules/profile_fixture';

test('entity rule fixture helper copies workflow-scoped and legacy entity rule fixtures into temporary rootDir', async () => {
    const fixture = await createEntityRuleFixtureRoot();
    try {
        const targetWorkflowRuleDir = path.join(fixture.rootDir, 'workflows', 'order-list', 'entity_rules', 'oa-ant-orders');
        const workflowStat = await fs.stat(targetWorkflowRuleDir);
        assert.equal(workflowStat.isDirectory(), true);

        const targetLegacyProfileDir = path.join(fixture.rootDir, 'entity_rules', 'profiles', 'oa-ant-orders');
        const legacyStat = await fs.stat(targetLegacyProfileDir);
        assert.equal(legacyStat.isDirectory(), true);

        const matchYaml = await fs.readFile(path.join(targetWorkflowRuleDir, 'match.yaml'), 'utf-8');
        assert.equal(matchYaml.includes('entities:'), true);
    } finally {
        await fixture.cleanup();
    }
});
