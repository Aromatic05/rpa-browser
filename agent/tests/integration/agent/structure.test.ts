import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../../src/agent');

test('agent implementation is grouped by responsibility instead of flat files', () => {
    const entries = fs.readdirSync(root, {withFileTypes: true});
    assert.equal(entries.some((entry) => entry.isFile()), false);
    assert.deepEqual(
        entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(),
        ['debug', 'execution', 'loop', 'model', 'service', 'tools', 'trace', 'worldview'],
    );
});
