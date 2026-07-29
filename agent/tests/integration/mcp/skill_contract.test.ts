import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const agentDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const skill = fs.readFileSync(path.join(agentDirectory, 'src/mcp/SKILL.md'), 'utf8');

test('MCP skill documents Snapshot V2 modes and canonical action targeting', () => {
    for (const mode of ['overview', 'interaction', 'annotation', 'debug', 'full']) {
        assert.match(skill, new RegExp(`\\b${mode}\\b`));
    }
    assert.match(skill, /nodeId/);
    assert.match(skill, /destCoord/);
    assert.match(skill, /browser\.entity.*op.*list/s);
});

test('MCP skill does not advertise removed snapshot or action fields', () => {
    for (const removed of [
        'focus_only',
        'includeA11y',
        'browser.click may also use `coord`',
        '`nodeId` or `id`',
        'list_entities',
        'find_entities',
    ]) {
        assert.equal(skill.includes(removed), false, `removed MCP guidance remains: ${removed}`);
    }
});
