import test from 'node:test';
import assert from 'node:assert/strict';
import {
    approvalAuditLine,
    createApprovalService,
    hashParameters,
} from '../../../src/security/approval';
import {createCredentialRef} from '../../../src/security/credentials';
import type {ApprovalRequest} from '../../../src/security/approval';

const SECRET = 'tok_hush-99';

const baseRequest = (): ApprovalRequest => ({
    id: 'req-1',
    operation: 'browser.fill',
    actor: 'user-1',
    scope: 'ws-main',
    parameters: {value: SECRET, ref: createCredentialRef({id: 'env:GITHUB_TOKEN'})},
    requestedAt: 1000,
});

test('identical requests produce identical decisions deterministically', () => {
    const service = createApprovalService({default: 'deny'});
    const one = service.evaluate(baseRequest());
    const two = service.evaluate(baseRequest());
    assert.deepEqual(one, two);
    assert.equal(one.outcome, 'denied');
});

test('slice of time does not change the decision', () => {
    const service = createApprovalService({default: 'deny'});
    const early = service.evaluate({...baseRequest(), requestedAt: 1});
    const late = service.evaluate({...baseRequest(), requestedAt: 9_999_999});
    assert.equal(early.outcome, late.outcome);
    assert.equal(early.reason, late.reason);
    assert.notEqual(early.decidedAt, late.decidedAt);
});

test('policy matrix maps to deterministic outcomes', () => {
    assert.equal(createApprovalService({default: 'allow'}).evaluate(baseRequest()).outcome, 'granted');
    assert.equal(createApprovalService({default: 'deny'}).evaluate(baseRequest()).outcome, 'denied');
    assert.equal(createApprovalService({default: 'require-human'}).evaluate(baseRequest()).outcome, 'human-required');
});

test('operation-specific overrides are deterministic and precise', () => {
    const service = createApprovalService({
        default: 'require-human',
        operations: {'browser.fill': 'deny', 'agent.run': 'allow'},
    });
    assert.equal(service.evaluate({...baseRequest(), operation: 'browser.fill'}).outcome, 'denied');
    assert.equal(service.evaluate({...baseRequest(), operation: 'agent.run'}).outcome, 'granted');
    assert.equal(service.evaluate({...baseRequest(), operation: 'browser.goto'}).outcome, 'human-required');
});

test('approval decisions are auditable without secret values', () => {
    const service = createApprovalService({default: 'deny'});
    const decision = service.evaluate(baseRequest());

    assert.ok(!JSON.stringify(decision).includes(SECRET));
    assert.ok(!JSON.stringify(decision.request).includes('parameters'));

    const line = approvalAuditLine(decision);
    assert.ok(!line.includes(SECRET));
    assert.ok(!line.includes('GITHUB_TOKEN'));
    assert.ok(line.includes('outcome=denied'), 'audit line must carry the outcome: ' + line);
    assert.ok(line.includes('policy=deny'));
    assert.ok(line.includes('operation=browser.fill'));
    assert.ok(line.includes('actor=user-1'));
    assert.ok(line.includes('scope=ws-main'));
    assert.ok(line.includes('request=req-1'));
    assert.ok(line.includes('params=sha256:'), 'audit line must name only a digest: ' + line);
});

test('parameters digest is stable under reordering and distinguishes content', () => {
    const a = hashParameters({a: 1, b: 2});
    const b = hashParameters({b: 2, a: 1});
    assert.equal(a, b);
    assert.notEqual(hashParameters({a: 1, b: 2}), hashParameters({a: 1, b: 3}));
    assert.equal(hashParameters(undefined), hashParameters(undefined));
    assert.notEqual(hashParameters(undefined), hashParameters(null));
});

test('audit lines are deterministic for the same decision', () => {
    const service = createApprovalService({default: 'deny'});
    const one = service.evaluate(baseRequest());
    const two = service.evaluate(baseRequest());
    assert.equal(approvalAuditLine(one), approvalAuditLine(two));
});

test('invalid policies are rejected at construction', () => {
    assert.throws(() => createApprovalService({default: 'banana' as 'allow'}), /must be one of/);
    assert.throws(() => createApprovalService({default: 'deny', operations: {x: 'banana' as 'allow'}}), /must be one of/);
});