import test from 'node:test';
import assert from 'node:assert/strict';
import {
    bearerTokenDigest,
    createBearerAuthenticator,
    parseBearerToken,
} from '../../../src/security/auth';
import type {Principal} from '../../../src/security/context';

const TOKEN = 'supersecret-token-abc';

const VERIFY = async (token: string): Promise<Principal | null> =>
    token === TOKEN ? {id: 'svc-1', kind: 'service', scopes: ['browser.read', 'agent.run']} : null;

test('parser accepts well-formed bearer tokens', () => {
    const parsed = parseBearerToken(`Bearer ${TOKEN}`);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
        assert.equal(parsed.token, TOKEN);
    }
    assert.equal(parseBearerToken('bearer lowercase').ok, true);
});

const FAILURE_CASES: ReadonlyArray<{authorization: string | null | undefined; code: string}> = [
    {authorization: undefined, code: 'missing'},
    {authorization: null, code: 'missing'},
    {authorization: '', code: 'missing'},
    {authorization: '   ', code: 'missing'},
    {authorization: 'Bearer', code: 'malformed'},
    {authorization: `Bearer ${TOKEN} extra`, code: 'malformed'},
    {authorization: `Bearer ${TOKEN},oops`, code: 'malformed'},
    {authorization: `bearer ${TOKEN}\tmore`, code: 'malformed'},
    {authorization: `Basic ${TOKEN}`, code: 'unsupported-scheme'},
    {authorization: `Unknown ${TOKEN}`, code: 'unsupported-scheme'},
    {authorization: '#$%not-a-header', code: 'malformed'},
];

test('parser fails closed and never echoes the token in any message', () => {
    for (const {authorization, code} of FAILURE_CASES) {
        const result = parseBearerToken(authorization);
        assert.equal(result.ok, false, `expected failure for ${String(authorization)}`);
        if (!result.ok) {
            assert.equal(result.code, code, `expected code ${code} for ${String(authorization)}`);
            assert.ok(!result.message.includes(TOKEN), `message must not contain the token: ${result.message}`);
            assert.ok(
                typeof authorization !== 'string' || authorization.length === 0
                    || !result.message.includes(authorization),
                'message must not echo the raw authorization header',
            );
        }
    }
});

test('authenticator succeeds only for a verified principal and never leaks the token', async () => {
    const auth = createBearerAuthenticator({verify: VERIFY});
    const result = await auth.authenticate(`Bearer ${TOKEN}`);
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.equal(result.principal.id, 'svc-1');
        assert.equal(result.scopes.has('browser.read'), true);
        assert.equal(result.capabilities.has('browser.read'), true);
        assert.equal(result.capabilities.has('browser.mutate'), false);
        assert.equal(result.tokenDigest, bearerTokenDigest(TOKEN));
        assert.ok(!result.tokenDigest.includes(TOKEN), 'only a digest may escape');
        assert.match(result.tokenDigest, /^sha256:[0-9a-f]{64}$/);
    }
});

test('authenticator fails closed on invalid, missing and unverifiable tokens', async () => {
    const auth = createBearerAuthenticator({verify: VERIFY});
    const wrong = await auth.authenticate(`Bearer ${TOKEN}x`);
    assert.equal(wrong.ok, false);
    if (!wrong.ok) {
        assert.equal(wrong.code, 'invalid-credential');
        assert.ok(!wrong.message.includes(TOKEN));
    }

    const missing = await auth.authenticate(undefined);
    assert.equal(missing.ok, false);
    if (!missing.ok) {
        assert.equal(missing.code, 'missing');
        assert.ok(!missing.message.includes(TOKEN));
    }

    const evil = await auth.authenticate(`Basic ${TOKEN}`);
    assert.equal(evil.ok, false);
    if (!evil.ok) {
        assert.equal(evil.code, 'unsupported-scheme');
        assert.ok(!evil.message.includes(TOKEN));
    }
});

test('authenticator fails closed when verification throws or returns junk', async () => {
    const throwing = createBearerAuthenticator({verify: async () => {
        throw new Error('db down');
    }});
    const thrown = await throwing.authenticate(`Bearer ${TOKEN}`);
    assert.equal(thrown.ok, false);
    if (!thrown.ok) {
        assert.equal(thrown.code, 'verification-failed');
        assert.ok(!thrown.message.includes(TOKEN));
        assert.ok(!thrown.message.includes('db down'), 'verifier errors must not leak either');
    }

    const junk = createBearerAuthenticator({verify: async () => ({id: '', kind: 'human'})});
    const junkResult = await junk.authenticate(`Bearer ${TOKEN}`);
    assert.equal(junkResult.ok, false);
    if (!junkResult.ok) {
        assert.equal(junkResult.code, 'invalid-credential');
        assert.ok(!junkResult.message.includes(TOKEN));
    }
});

test('malformed input never reaches the verifier (fail-closed enforcement)', async () => {
    let called = false;
    const auth = createBearerAuthenticator({verify: async (token) => {
        called = true;
        return {id: token, kind: 'service'};
    }});
    for (const {authorization} of FAILURE_CASES) {
        if (authorization === undefined) {continue;}
        const result = await auth.authenticate(authorization);
        assert.equal(result.ok, false);
        assert.ok(!result.message.includes(TOKEN));
    }
    assert.equal(called, false, 'verifier must not run for malformed headers');
});

test('bearer digest is deterministic and opaque', () => {
    assert.equal(bearerTokenDigest('abc'), bearerTokenDigest('abc'));
    assert.notEqual(bearerTokenDigest('abc'), bearerTokenDigest('abd'));
    assert.match(bearerTokenDigest('abc'), /^sha256:[0-9a-f]{64}$/);
    assert.ok(!bearerTokenDigest(TOKEN).includes(TOKEN));
});