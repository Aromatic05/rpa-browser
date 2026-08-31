import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CAPABILITIES,
    capabilityForActionType,
    capabilityForBrowserTool,
    capabilityForTool,
    parseCapabilities,
} from '../../../src/security/capabilities';
import {
    authorizeBrowserTool,
    can,
    canAll,
    canAny,
    createSecurityContext,
    isPrincipal,
    requireCapability,
} from '../../../src/security/context';
import {createDenyAllCredentialResolver} from '../../../src/security/credentials';
import {SecurityError} from '../../../src/security/errors';
import type {Principal} from '../../../src/security/context';
import type {Capability} from '../../../src/security/capabilities';

const PRINCIPAL: Principal = {id: 'user-1', kind: 'human', displayName: 'tester'};
const RESOLVER = createDenyAllCredentialResolver();

const context = (capabilities: readonly Capability[]): ReturnType<typeof createSecurityContext> =>
    createSecurityContext({principal: PRINCIPAL, workspace: 'ws-main', capabilities, resolver: RESOLVER});

test('capability taxonomy covers the delivery surface', () => {
    for (const capability of [
        'agent.run',
        'browser.read',
        'browser.mutate',
        'browser.evaluate',
        'tabs',
        'program.execute',
        'program.save',
        'debug.control',
        'control.eval',
    ]) {
        assert.equal(parseCapabilities([capability]).includes(capability as Capability), true);
    }
});

test('capability parsing rejects unknown names fail-closed', () => {
    assert.throws(
        () => parseCapabilities(['browser.read', 'wipe-everything']),
        (error: unknown) => error instanceof SecurityError && error.code === 'ERR_SECURITY_UNKNOWN_CAPABILITY',
    );
    assert.throws(() => parseCapabilities([42]), /unknown capabilities/);
});

test('capability checks are fail-closed', () => {
    const readOnly = context(['browser.read', 'tabs']);
    assert.equal(can(readOnly, 'browser.read'), true);
    assert.equal(can(readOnly, 'browser.mutate'), false);
    assert.equal(can(readOnly, 'browser.evaluate'), false, 'evaluate must not be implied by read');
    assert.equal(can(readOnly, 'agent.run'), false);

    assert.throws(
        () => requireCapability(readOnly, 'browser.evaluate', 'evaluate'),
        (error: unknown) => error instanceof SecurityError && error.code === 'ERR_SECURITY_DENIED',
    );
});

test('browser tool authorization grants only the mapped capability', () => {
    const ctx = context(['browser.mutate']);
    assert.throws(() => authorizeBrowserTool(ctx, 'browser.snapshot', 'read'), /missing capability browser.read/);
    assert.throws(() => authorizeBrowserTool(ctx, 'unknown.tool', 'op'), /no capability is bound/);
    assert.equal(authorizeBrowserTool(ctx, 'browser.click', 'click'), 'browser.mutate');
});

test('tool and action mapping is complete for the taxonomy', () => {
    assert.equal(capabilityForBrowserTool('browser.click'), 'browser.mutate');
    assert.equal(capabilityForBrowserTool('browser.fill'), 'browser.mutate');
    assert.equal(capabilityForBrowserTool('browser.snapshot'), 'browser.read');
    assert.equal(capabilityForBrowserTool('browser.read_console'), 'browser.read');
    assert.equal(capabilityForBrowserTool('browser.evaluate'), 'browser.evaluate');
    assert.equal(capabilityForBrowserTool('browser.mouse'), 'browser.evaluate');
    assert.equal(capabilityForBrowserTool('browser.create_tab'), 'tabs');
    assert.equal(capabilityForBrowserTool('browser.list_tabs'), 'tabs');
    assert.equal(capabilityForBrowserTool('unknown.tool'), null);

    assert.equal(capabilityForTool('agent.run'), 'agent.run');
    assert.equal(capabilityForTool('agent.execute_program'), 'program.execute');
    assert.equal(capabilityForTool('agent.save_program'), 'program.save');
    assert.equal(capabilityForTool('control.eval'), 'control.eval');
    assert.equal(capabilityForTool('debug.rollback'), 'debug.control');
    assert.equal(capabilityForTool('browser.evaluate'), 'browser.evaluate');
    assert.equal(capabilityForTool('unknown.tool'), null);

    assert.equal(capabilityForActionType('agent.run'), 'agent.run');
    assert.equal(capabilityForActionType('agent.sessions.start'), 'agent.run');
    assert.equal(capabilityForActionType('tab.list'), 'tabs');
    assert.equal(capabilityForActionType('dsl.run'), 'program.execute');
    assert.equal(capabilityForActionType('dsl.save'), 'program.save');
    assert.equal(capabilityForActionType('debug.step'), 'debug.control');
    assert.equal(capabilityForActionType('control.eval'), 'control.eval');
    assert.equal(capabilityForActionType('workflow.list'), null);
});

test('canAny and canAll compose fail-closed semantics', () => {
    const ctx = context(['tabs', 'browser.read']);
    assert.equal(canAll(ctx, [CAPABILITIES.TABS, CAPABILITIES.BROWSER_READ]), true);
    assert.equal(canAll(ctx, [CAPABILITIES.TABS, CAPABILITIES.BROWSER_MUTATE]), false);
    assert.equal(canAny(ctx, [CAPABILITIES.BROWSER_MUTATE, CAPABILITIES.AGENT_RUN]), false);
    assert.equal(canAny(ctx, [CAPABILITIES.TABS]), true);
});

test('principal validation rejects malformed principals', () => {
    assert.equal(isPrincipal({id: 'u1', kind: 'human'}), true);
    assert.equal(isPrincipal({id: 'u1', kind: 'service', scopes: ['browser.read']}), true);
    assert.equal(isPrincipal({id: 'u1', kind: 'robot'}), false);
    assert.equal(isPrincipal({id: '', kind: 'human'}), false);
    assert.equal(isPrincipal({id: 'u1', kind: 'human', scopes: ['ok', 42]}), false);
    assert.equal(isPrincipal('not-an-object'), false);
});

test('createSecurityContext validates workspace and freezes capabilities', () => {
    const bogusPrincipal = {id: 'x', kind: 'robot'} as unknown as Principal;
    assert.throws(
        () => createSecurityContext({principal: PRINCIPAL, workspace: '  ', capabilities: ['browser.read'], resolver: RESOLVER}),
        /workspace must be a non-empty string/,
    );
    assert.throws(
        () => createSecurityContext({principal: bogusPrincipal, workspace: 'ws', capabilities: ['browser.read'], resolver: RESOLVER}),
        /invalid principal/,
    );

    const ctx = context([CAPABILITIES.BROWSER_READ]);
    assert.equal(ctx.workspace, 'ws-main');
    assert.throws(() => (ctx.capabilities as Capability[]).push(CAPABILITIES.BROWSER_MUTATE), TypeError);
    assert.equal(can(ctx, CAPABILITIES.BROWSER_MUTATE), false);
});

test('capability parsing deduplicates and returns an immutable list', () => {
    const parsed = parseCapabilities(['tabs', 'tabs', 'browser.read']);
    assert.equal(parsed.length, 2);
    assert.throws(() => (parsed as Capability[]).push(CAPABILITIES.AGENT_RUN), TypeError);
});