import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createCredentialRef,
    createDenyAllCredentialResolver,
    createEnvCredentialResolver,
    createMemoryCredentialResolver,
    credentialRefForEnv,
    parseCredentialRef,
    serializeCredentialRef,
} from '../../../src/security/credentials';

const TOKEN = 'ghp_0123supersecret';

test('credential refs serialize safely and never leak the resolved value', async () => {
    const resolver = createMemoryCredentialResolver({'env:GITHUB_TOKEN': TOKEN});
    const ref = credentialRefForEnv('GITHUB_TOKEN');
    assert.equal(resolver.has(ref), true);

    assert.ok(!JSON.stringify(ref).includes(TOKEN));
    assert.ok(!JSON.stringify(ref).includes('ghp_'));
    assert.ok(!serializeCredentialRef(ref).includes(TOKEN));

    const roundTrip = parseCredentialRef(serializeCredentialRef(ref));
    assert.deepEqual(roundTrip, ref);

    const resolved = await resolver.resolve(ref);
    assert.equal(resolved, TOKEN);
});

test('credential ref deserialization rejects embedded raw values fail-closed', () => {
    const withValue = JSON.stringify({id: 'env:GITHUB_TOKEN', value: TOKEN});
    assert.throws(() => parseCredentialRef(withValue), /unsupported fields/);
    assert.throws(() => parseCredentialRef('not-json'), /valid json/);
    assert.throws(() => parseCredentialRef('{"id":1}'), /string id/);
    assert.throws(() => parseCredentialRef('{"id":""}'), /non-empty/);
});

test('credential ref construction validates shape', () => {
    assert.throws(() => createCredentialRef({id: 'x', kind: 'nope'}), /unknown credential kind/);
    assert.throws(() => createCredentialRef({id: '   '}), /non-empty/);
    assert.equal(createCredentialRef({id: 'x'}).kind, 'credential');
    assert.equal(createCredentialRef({id: 'x', provider: 'env'}).provider, 'env');
});

test('serialization is stable across identical refs', () => {
    const one = createCredentialRef({id: 'env:GITHUB_TOKEN', kind: 'credential', provider: 'env', hint: 'resolved from environment GITHUB_TOKEN'});
    const two = createCredentialRef({id: 'env:GITHUB_TOKEN', kind: 'credential', provider: 'env', hint: 'resolved from environment GITHUB_TOKEN'});
    assert.equal(serializeCredentialRef(one), serializeCredentialRef(two));
    assert.equal(parseCredentialRef(serializeCredentialRef(one)).id, one.id);
});

test('memory resolver fails closed on unknown refs', async () => {
    const resolver = createMemoryCredentialResolver({'env:GITHUB_TOKEN': TOKEN});
    const unknown = createCredentialRef({id: 'cred:nope'});
    assert.equal(resolver.has(unknown), false);
    await assert.rejects(resolver.resolve(unknown), /not found/);
});

test('env resolver reads injected environment and never exposes values through describe', async () => {
    const resolver = createEnvCredentialResolver({'GITHUB_TOKEN': TOKEN});
    const ref = credentialRefForEnv('GITHUB_TOKEN');
    assert.equal(resolver.has(ref), true);
    assert.equal(await resolver.resolve(ref), TOKEN);
    assert.ok(!resolver.describe(ref).includes(TOKEN));

    const missing = credentialRefForEnv('MISSING_VAR');
    assert.equal(resolver.has(missing), false);
    await assert.rejects(resolver.resolve(missing), /environment credential not found/);
});

test('deny-all resolver fails closed without a secret store', async () => {
    const resolver = createDenyAllCredentialResolver();
    const ref = credentialRefForEnv('GITHUB_TOKEN');
    assert.equal(resolver.has(ref), false);
    await assert.rejects(resolver.resolve(ref), /resolution is denied/);
    assert.ok(resolver.describe(ref).startsWith('credential:') || resolver.describe(ref).includes('env'));
    assert.ok(!resolver.describe(ref).includes(TOKEN));
});