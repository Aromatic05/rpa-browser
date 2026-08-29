import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAgentRunReport} from '../../../../src/agent/report/builder';
import {parseAgentRunReport, serializeAgentRunReport} from '../../../../src/agent/report/serialization';
import {createAgentContextAccountant} from '../../../../src/agent/tools/context/budget';
import {baselineResult, successResult} from './fixtures';

test('report serialization round-trips through the validation boundary', () => {
    const report = buildAgentRunReport(successResult());
    const json = serializeAgentRunReport(report);
    const parsed = parseAgentRunReport(json);
    assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(report)));
    assert.deepEqual(parsed, JSON.parse(json));
});

test('report serialization is byte-stable across key insertion orders', () => {
    const report = buildAgentRunReport(successResult(), {generatedAt: '2026-08-29T00:00:00.000Z'});
    const shuffled = {
        savedArtifacts: report.savedArtifacts,
        effects: report.effects,
        schemaVersion: report.schemaVersion,
        toolMetrics: report.toolMetrics,
        schema: report.schema,
        programs: report.programs,
        terminal: report.terminal,
        world: report.world,
        run: report.run,
        toolCalls: report.toolCalls,
        context: report.context,
        generatedAt: report.generatedAt,
    };
    assert.equal(
        serializeAgentRunReport(shuffled as typeof report),
        serializeAgentRunReport(report),
    );
});

test('validation boundary rejects reports from other schema versions or shapes', () => {
    const json = serializeAgentRunReport(buildAgentRunReport(successResult()));

    assert.throws(() => parseAgentRunReport(json.replace('"schemaVersion":1', '"schemaVersion":2')));
    assert.throws(() => parseAgentRunReport(json.replace('"rpa.agent.run-report"', '"other-schema"')));

    const parsed = JSON.parse(json) as Record<string, unknown>;
    delete parsed.effects;
    assert.throws(() => parseAgentRunReport(JSON.stringify(parsed)));

    const withExtra = {...JSON.parse(json), surplus: true};
    assert.throws(() => parseAgentRunReport(JSON.stringify(withExtra)));

    assert.throws(() => parseAgentRunReport('not json'));
});

test('report never carries raw secret values from tool args, scopes, or program input', () => {
    const result = baselineResult();
    result.trace.tools.push({
        toolCallId: 't3',
        toolName: 'browser.fill',
        classification: 'effect',
        startedAt: 300,
        endedAt: 310,
        args: {
            selector: '#login',
            password: 'hunter2',
            apiKey: 'sk-live-123',
            authToken: 'tok-1',
            nested: {sessionCookie: 'cookie-secret', label: 'public'},
        },
    });
    result.trace.tools.push({
        toolCallId: 't4',
        toolName: 'agent.execute_program',
        classification: 'control',
        startedAt: 400,
        endedAt: 410,
        args: {source: 'output done = true', input: {value: 'plain', secret: 'hidden'}},
    });
    result.programs = [{
        source: 'output done = true',
        input: {value: 'plain', secret: 'hidden'},
        status: 'completed',
        text: '{"done":true}',
        effects: [],
    }];

    const json = serializeAgentRunReport(buildAgentRunReport(result));
    for (const secret of ['hunter2', 'sk-live-123', 'tok-1', 'cookie-secret', 'hidden']) {
        assert.equal(json.includes(secret), false, `report leaked ${secret}`);
    }
    assert.equal(json.includes('plain'), true);

    const report = parseAgentRunReport(json);
    const fill = report.toolCalls.find((call) => call.toolName === 'browser.fill')!;
    assert.deepEqual(fill.args, {
        selector: '#login',
        password: '[redacted]',
        apiKey: '[redacted]',
        authToken: '[redacted]',
        nested: {sessionCookie: '[redacted]', label: 'public'},
    });
    assert.deepEqual(fill.redactedPaths, ['apiKey', 'authToken', 'nested.sessionCookie', 'password']);

    const execute = report.toolCalls.find((call) => call.toolName === 'agent.execute_program')!;
    assert.deepEqual(execute.args, {source: 'output done = true', input: {value: 'plain', secret: '[redacted]'}});
    assert.deepEqual(execute.redactedPaths, ['input.secret']);

    assert.deepEqual(report.programs[0].inputKeys, ['secret', 'value']);
});

test('old reports without a context field still parse: context stays absent', () => {
    const json = serializeAgentRunReport(buildAgentRunReport(baselineResult()));
    const parsed = parseAgentRunReport(json);
    assert.equal(parsed.context, undefined);
    assert.deepEqual(parsed, JSON.parse(json));

    const withContext = JSON.parse(serializeAgentRunReport(buildAgentRunReport(successResult()))) as Record<string, unknown>;
    delete withContext.context;
    const parsedWithout = parseAgentRunReport(JSON.stringify(withContext));
    assert.equal(parsedWithout.context, undefined);
});

test('context metrics round-trip exact counts and never persist canary content', () => {
    const accountant = createAgentContextAccountant();
    accountant.recordTurn('SECRET_SYSTEM_PROMPT_CANARY', [
        {role: 'user', content: [{type: 'text', text: 'CANARY_SECRET_VALUE_1234'}], timestamp: 1},
    ], []);
    const result = baselineResult();
    result.trace.context = accountant.account();
    const json = serializeAgentRunReport(buildAgentRunReport(result));
    const report = parseAgentRunReport(json);

    assert.ok(report.context);
    assert.equal(report.context.turns.length, 1);
    assert.equal(report.context.lastChars, report.context.turns[0]?.chars);
    assert.equal(report.context.peakChars, report.context.turns[0]?.chars);
    assert.equal(report.context.lastBytes, report.context.turns[0]?.bytes);
    assert.ok((report.context.lastChars ?? 0) > 0);

    assert.equal(json.includes('CANARY_SECRET_VALUE_1234'), false);
    assert.equal(json.includes('SECRET_SYSTEM_PROMPT_CANARY'), false);
    assert.equal(json.includes('canary'), false);
});
