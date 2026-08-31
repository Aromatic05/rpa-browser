import test from 'node:test';
import assert from 'node:assert/strict';
import {createRedactionPolicy} from '../../../src/security/redaction';

const SECRET_A = 's3cr3t-42';
const SECRET_B = 'tok_hush';

test('registered exact secret values never survive under arbitrary key names', () => {
    const policy = createRedactionPolicy({secrets: [SECRET_A, SECRET_B]});
    const result = policy.redact({
        alpha: {beta: [{gamma: SECRET_A}]},
        weird_key_xyz: SECRET_A,
        notes: `prefix ${SECRET_A} suffix`,
        list: [[SECRET_B], SECRET_A],
    });
    const serialized = JSON.stringify(result.value);
    assert.ok(!serialized.includes(SECRET_A), 'secret A must not survive redaction, got: ' + serialized);
    assert.ok(!serialized.includes(SECRET_B), 'secret B must not survive redaction, got: ' + serialized);

    const value = result.value as {
        alpha: {beta: Array<{gamma: string}>};
        weird_key_xyz: string;
        notes: string;
        list: unknown[][];
    };
    assert.equal(value.alpha.beta[0].gamma, '[redacted]');
    assert.equal(value.weird_key_xyz, '[redacted]');
    assert.equal(value.notes, 'prefix [redacted] suffix');
    assert.equal(value.list[0][0], '[redacted]');
    assert.ok(result.redactedPaths.includes('alpha.beta[0].gamma'));
    assert.ok(result.redactedPaths.includes('weird_key_xyz'));
    assert.ok(result.redactedPaths.includes('notes'));
});

test('sensitive keys are masked by key name while innocent keys pass through', () => {
    const policy = createRedactionPolicy({secrets: [SECRET_B]});
    const result = policy.redact({
        password: 'p1',
        Authorization: 'p2',
        'X-API-KEY': 'k',
        token: {x: 1},
        user: {passwd: 'p3'},
        name: 'safe',
        title: 'ok',
    });
    const value = result.value as Record<string, unknown>;
    assert.equal(value.password, '[redacted]');
    assert.equal(value.Authorization, '[redacted]');
    assert.equal((value as Record<string, unknown>)['X-API-KEY'], '[redacted]');
    assert.equal(value.token, '[redacted]');
    assert.equal((value.user as Record<string, unknown>).passwd, '[redacted]');
    assert.equal(value.name, 'safe');
    assert.equal(value.title, 'ok');

    assert.equal(policy.isSensitiveKey('X-API-KEY'), true);
    assert.equal(policy.isSensitiveKey('api_key'), true);
    assert.equal(policy.isSensitiveKey('my-access-token'), true);
    assert.equal(policy.isSensitiveKey('notsosecret'), false);
    const paths = result.redactedPaths;
    assert.ok(paths.includes('password'));
    assert.ok(paths.includes('Authorization'));
    assert.ok(paths.includes('X-API-KEY'));
    assert.ok(paths.includes('token'));
    assert.ok(paths.includes('user.passwd'));
    assert.ok(!paths.includes('name'));
});

test('URL query, fragment and userinfo are sanitized', () => {
    const policy = createRedactionPolicy({secrets: [SECRET_B, 'k#2']});

    const url = policy.redactString(`https://example.com/path?token=${SECRET_B}&api_key=super&q=keep%20me#k#2`).value as string;
    assert.ok(!url.includes(SECRET_B), 'query secret must be masked, got: ' + url);
    assert.ok(!url.includes('k#2'), 'fragment secret must be masked, got: ' + url);
    assert.ok(url.includes('api_key=' + encodeURIComponent('[redacted]')), 'sensitive query keys must be masked, got: ' + url);
    assert.ok(url.includes('q='), 'non-secret query params must survive, got: ' + url);
    assert.ok(!url.includes('super'), 'sensitive query value must not survive, got: ' + url);
    assert.ok(url.includes('[redacted]'), 'masked components must be marked, got: ' + url);

    const userinfo = policy.redactString('https://user:supersecret@example.com/').value as string;
    assert.ok(!userinfo.includes('supersecret'), 'userinfo password must be masked, got: ' + userinfo);

    const plain = policy.redactString('just a plain string, not a url').value as string;
    assert.equal(plain, 'just a plain string, not a url');
});

test('Error objects are sanitized across message, stack and cause', () => {
    const policy = createRedactionPolicy({secrets: [SECRET_B]});
    const inner = new Error(`inner ${SECRET_B}`);
    const boom: Error & {code: string} = Object.assign(new Error(`failed ${SECRET_B}`), {code: 'E_COOL'});
    boom.cause = inner;

    const result = policy.redact({status: 'error', error: boom, rows: [1, 2]});
    const serialized = JSON.stringify(result.value);
    assert.ok(!serialized.includes(SECRET_B), 'error payload must not leak secrets, got: ' + serialized);

    const value = result.value as {error: {message: string; stack: string; cause: {message: string}}};
    assert.equal(value.error.message, 'failed [redacted]');
    assert.ok(!value.error.stack.includes(SECRET_B));
    assert.equal(value.error.cause.message, 'inner [redacted]');
    assert.ok(result.redactedPaths.includes('error.stack'));
    assert.ok(result.redactedPaths.includes('error.message'));
    assert.ok(result.redactedPaths.includes('error.cause.message'));
});

test('nested structures are sanitized and verified end-to-end', () => {
    const policy = createRedactionPolicy({secrets: [SECRET_B]});
    const input = {
        outer: {
            middleware: [[{header: `Authorization: Bearer ${SECRET_B}`}]],
            url: `https://host/api?access_token=${SECRET_B}`,
        },
    };
    const result = policy.redact(input);
    const serialized = JSON.stringify(result.value);
    assert.ok(!serialized.includes(SECRET_B), 'nested payload must not leak secrets, got: ' + serialized);
    assert.ok(result.redactedPaths.includes('outer.middleware[0][0].header'));
    assert.ok(result.redactedPaths.includes('outer.url'));
});

test('output bounds truncate deterministically', () => {
    const truncPolicy = createRedactionPolicy({maxStringLength: 12});
    const str = truncPolicy.redactString('a'.repeat(40)).value as string;
    assert.equal(str, 'aaaaaaaaaaaa[truncated]');

    const depthPolicy = createRedactionPolicy({maxDepth: 2});
    const deep = depthPolicy.redact({a: {b: {c: {d: SECRET_B}}}}).value as {a: {b: {c: unknown}}};
    assert.equal(deep.a.b.c, '[max-depth]');
    assert.ok(!JSON.stringify(depthPolicy.redact({a: {b: {c: {d: SECRET_B}}}}).value).includes(SECRET_B));

    const arrayPolicy = createRedactionPolicy({maxArrayItems: 2});
    const arr = arrayPolicy.redact([1, 2, 3, 4]).value as unknown[];
    assert.deepEqual(arr, [1, 2, '[truncated]']);

    const objectPolicy = createRedactionPolicy({maxObjectKeys: 2});
    const obj = objectPolicy.redact({a: 1, b: 2, c: 3}).value as Record<string, unknown>;
    assert.equal('a' in obj, true);
    assert.equal('b' in obj, true);
    assert.equal('c' in obj, false);
    assert.equal(obj['[truncated]'], '[truncated]');
});

test('redaction is deterministic and json-safe', () => {
    const policy = createRedactionPolicy({secrets: [SECRET_A, SECRET_B]});
    const input = {
        a: {b: [SECRET_A, {c: SECRET_B}], d: `x${SECRET_B}y`},
        e: 'http://host?tok=abc',
    };
    const first = policy.redact(input);
    const second = policy.redact(input);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first.value), JSON.stringify(second.value));
    assert.doesNotThrow(() => JSON.stringify({root: first.value, nested: {again: first.value}}));

    const stringResult = policy.redactString(SECRET_A);
    assert.deepEqual(stringResult.redactedPaths, ['value']);
    assert.equal(stringResult.value, '[redacted]');
});

test('registeredSecrets snapshot is immutable and detached from the policy', () => {
    const policy = createRedactionPolicy({secrets: [SECRET_A, SECRET_B]});
    const registered = policy.registeredSecrets();
    assert.equal(registered.includes(SECRET_A), true);
    assert.equal(registered.includes(SECRET_B), true);
    assert.throws(() => (registered as string[]).push('bogus-secret'), TypeError);
    const result = policy.redact({key: 'bogus-secret'}).value as Record<string, unknown>;
    assert.equal(result.key, 'bogus-secret', 'mutating a snapshot must not corrupt the policy');

    const subset = createRedactionPolicy({secrets: [SECRET_A]});
    const rest = subset.redact({key: SECRET_A, other: SECRET_B}).value as Record<string, unknown>;
    assert.equal(rest.key, '[redacted]');
    assert.equal(rest.other, SECRET_B, 'unregistered secrets must pass through unchanged');
});

test('values that merely contain a secret are masked in place', () => {
    const policy = createRedactionPolicy({secrets: [SECRET_B]});
    const result = policy.redact({slug: `pre-${SECRET_B}-post`});
    assert.equal((result.value as Record<string, unknown>).slug, 'pre-[redacted]-post');
});