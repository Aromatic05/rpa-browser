import test from 'node:test';
import assert from 'node:assert/strict';
import {createBearerAuthenticator} from '../../../src/security/auth';
import {createSecurityContext, can} from '../../../src/security/context';
import {createMemoryCredentialResolver, credentialRefForEnv} from '../../../src/security/credentials';
import {createRedactionPolicy} from '../../../src/security/redaction';
import {createApprovalService, approvalAuditLine} from '../../../src/security/approval';
import {authorizeBrowserTool} from '../../../src/security/context';
import {capabilityForTool} from '../../../src/security/capabilities';

test('auth -> context -> credential resolution -> redaction composes end-to-end', async () => {
    const rawSecret = 'live-secret-42';
    const token = 'issued.bearer.jwt';

    const auth = createBearerAuthenticator({
        verify: async (received) =>
            received === token ? {id: 'svc-robot', kind: 'service', scopes: ['browser.mutate', 'tabs']} : null,
    });
    const outcome = await auth.authenticate(`Bearer ${token}`);
    assert.equal(outcome.ok, true, 'authenticated principal expected');
    if (!outcome.ok) {throw new Error('auth failed');}

    const resolver = createMemoryCredentialResolver({'env:SITE_TOKEN': rawSecret});
    const ctx = createSecurityContext({
        principal: outcome.principal,
        workspace: 'ws-prod',
        capabilities: outcome.capabilities,
        resolver,
    });
    assert.equal(can(ctx, 'browser.mutate'), true);
    assert.equal(can(ctx, 'browser.evaluate'), false);
    assert.equal(authorizeBrowserTool(ctx, 'browser.click', 'automation'), 'browser.mutate');
    assert.throws(() => authorizeBrowserTool(ctx, 'browser.evaluate', 'automation'));

    const ref = credentialRefForEnv('SITE_TOKEN');
    const resolved = await ctx.resolver.resolve(ref);
    assert.equal(resolved, rawSecret);

    const policy = createRedactionPolicy({secrets: [rawSecret]});
    const modelInput = {
        task: 'run login',
        arbitrary_pair: {unknown_key: `Bearer ${rawSecret}`},
        url: 'https://site.example/login?login=1&password=' + rawSecret,
    };
    const sanitized = policy.redact(modelInput);
    const serialized = JSON.stringify(sanitized.value);
    assert.ok(!serialized.includes(rawSecret), 'resolved secrets must never reach model-visible input');
});

test('capability taxonomy + approval cover an agent.run delivery flow', () => {
    assert.equal(capabilityForTool('agent.execute_program'), 'program.execute');
    assert.equal(capabilityForTool('agent.save_program'), 'program.save');
    assert.equal(capabilityForTool('control.eval'), 'control.eval');

    const approvals = createApprovalService({default: 'require-human'});
    const decision = approvals.evaluate({
        id: 'req-run-1',
        operation: 'program.execute',
        actor: 'svc-robot',
        scope: 'ws-prod',
        parameters: {programRef: 'cred:env:SITE_TOKEN'},
        requestedAt: 1234,
    });
    assert.equal(decision.outcome, 'human-required');
    const line = approvalAuditLine(decision);
    assert.ok(!line.includes('live-secret-42'));
    assert.ok(!line.includes('env:SITE_TOKEN'));
    assert.ok(line.includes('operation=program.execute'));
});