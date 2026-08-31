import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDslDocument} from '../../../../../src/program/dsl/parser';
import {materializeDebugProgramSource} from '../../../../../src/agent/debug/program/materialize';
import {buildDebugProgramView} from '../../../../../src/agent/debug/program/view';
import type {DebugProgramPatch} from '../../../../../src/agent/debug/program/patches';

const view = (source: string) => {
    const parsed = parseDslDocument(source);
    return buildDebugProgramView({
        programId: 'main',
        source,
        program: parsed.program,
        sourceMap: parsed.sourceMap,
    });
};

const patch = (path: string, source: string): DebugProgramPatch => ({
    programId: 'main',
    path,
    source,
    statement: parseDslDocument(source).program.body[0],
});

test('materialized Program source applies multiple durable leaf patches without mutating the ProgramView', () => {
    const source = [
        'output first = input.first',
        'output second = input.second',
        '',
    ].join('\n');
    const program = view(source);
    const materialized = materializeDebugProgramSource(program, [
        patch('body.0', 'output first = input.changed'),
        patch('body.1', 'output second = input.changedSecond'),
    ]);

    assert.equal(materialized, [
        'output first = input.changed',
        'output second = input.changedSecond',
        '',
    ].join('\n'));
    assert.equal(program.source, source);
});

test('materialized Program source preserves indentation for nested patched statements', () => {
    const source = [
        'if input.ok:',
        '  output value = input.before',
        'else:',
        '  output value = input.other',
    ].join('\n');
    const program = view(source);
    const materialized = materializeDebugProgramSource(program, [
        patch('body.0.then.0', 'output value = input.after'),
        patch('body.0.else.0', 'output value = input.changedOther'),
    ]);

    assert.equal(materialized, [
        'if input.ok:',
        '  output value = input.after',
        'else:',
        '  output value = input.changedOther',
    ].join('\n'));
});
