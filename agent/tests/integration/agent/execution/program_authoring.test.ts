import test from 'node:test';
import assert from 'node:assert/strict';
import {PROGRAM_DSL_EXAMPLES} from '../../../../src/agent/execution/program/authoring';
import {compileDslSource} from '../../../../src/automation/dsl/runtime';

test('program authoring examples stay accepted by the real DSL compiler', () => {
    for (const example of PROGRAM_DSL_EXAMPLES) {
        assert.doesNotThrow(
            () => compileDslSource(example.source),
            `authoring example is stale: ${example.purpose}`,
        );
    }
});
