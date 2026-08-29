import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSecretRef } from '../../../../src/platform/config/secret_ref';
import type { SecretFileStat, SecretFileSystem } from '../../../../src/platform/security/contracts';
import { SecretResolutionError } from '../../../../src/platform/security/error';
import {
    createSecretRefResolver,
    credentialResolverFromSecretRefResolver,
    envOf,
    nodeFileSystem,
} from '../../../../src/platform/security/secret_ref_resolver';
import { credentialRefForEnv, createCredentialRef } from '../../../../src/security/credentials';
import { sha256Hex } from '../../../../src/security/digest';
import { SecurityError } from '../../../../src/security/errors';

const withSecretsDir = async <T>(run: (baseDir: string, dir: string) => Promise<T> | T): Promise<T> => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'secret-resolver-'));
    const baseDir = path.join(dir, 'secrets');
    mkdirSync(baseDir, {recursive: true});
    try {
        return await run(baseDir, dir);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
};

type FakeEntry =
    | {type: 'file'; content: string; mode: number}
    | {type: 'dir'};

const normalizePath = (p: string): string => p.replace(/\/{2,}/g, '/');

const fakeFileSystem = (entries: Readonly<Record<string, FakeEntry>>): SecretFileSystem => {
    const find = (filePath: string): FakeEntry | undefined => entries[normalizePath(filePath)];
    return {
        realpathSync: (filePath) => {
            if (find(filePath) === undefined) {throw new Error('ENOENT');}
            return normalizePath(filePath);
        },
        statSync: (filePath): SecretFileStat => {
            const entry = find(filePath);
            if (entry === undefined) {throw new Error('ENOENT');}
            return {
                size: entry.type === 'file' ? entry.content.length : 0,
                mode: entry.type === 'file' ? entry.mode : 0o100755,
                isFile: () => entry.type === 'file',
                isDirectory: () => entry.type === 'dir',
                isSymbolicLink: () => false,
            };
        },
        readFileSync: (filePath) => {
            const entry = find(filePath);
            if (entry === undefined) {throw new Error('ENOENT');}
            if (entry.type !== 'file') {throw new Error('EISDIR');}
            return entry.content;
        },
    };
};

const fakeStore = {
    '/fake/secrets': {type: 'dir'},
    '/fake/secrets/nested': {type: 'dir'},
    '/fake/secrets/agent.token': {type: 'file', content: 'from-fake-fs\n', mode: 0o600},
    '/fake/secrets/nested/key.token': {type: 'file', content: 'nested-key', mode: 0o600},
    '/fake/secrets/sub': {type: 'dir'},
    '/fake/secrets/loose.token': {type: 'file', content: 'loose', mode: 0o644},
    '/fake/secrets/private.token': {type: 'file', content: 'private-value', mode: 0o600},
} satisfies Readonly<Record<string, FakeEntry>>;

test('env references resolve from injected environment and fail closed when missing or empty', async () => {
    const resolver = createSecretRefResolver({
        env: envOf({API_KEY: 'sk-live-123'}),
        fs: nodeFileSystem(),
        baseDir: '/unused',
    });
    const result = await resolver.resolve(parseSecretRef('env:API_KEY'));
    assert.equal(result.value, 'sk-live-123');
    assert.equal(result.digest, sha256Hex('sk-live-123'));
    assert.equal(result.refString, 'env:API_KEY');
    assert.equal(result.source, 'resolved from environment API_KEY');
    assert.equal(result.kind, 'env');
    assert.equal(resolver.has(parseSecretRef('env:API_KEY')), true);

    const emptyResolver = createSecretRefResolver({env: envOf({EMPTY: ''}), fs: nodeFileSystem(), baseDir: '/unused'});
    await assert.rejects(emptyResolver.resolve(parseSecretRef('env:EMPTY')), (error: unknown) =>
        error instanceof SecretResolutionError && error.code === 'ERR_SECRET_ENV_NOT_SET');
    assert.equal(emptyResolver.has(parseSecretRef('env:EMPTY')), false);

    await assert.rejects(resolver.resolve(parseSecretRef('env:MISSING')), (error: unknown) =>
        error instanceof SecretResolutionError && error.code === 'ERR_SECRET_ENV_NOT_SET');
    assert.equal(resolver.has(parseSecretRef('env:MISSING')), false);
});

test('file references resolve within the trusted base and strip only terminal newlines', async () => {
    await withSecretsDir(async (baseDir) => {
        const resolver = createSecretRefResolver({env: envOf({}), fs: nodeFileSystem(), baseDir});
        const cases: ReadonlyArray<readonly [string, string, string]> = [
            ['lf.token', 'tok-1\n', 'tok-1'],
            ['crlf.token', 'tok-2\r\n', 'tok-2'],
            ['spaced.token', ' tok-3 \n', ' tok-3 '],
            ['double-newline.token', 'tok-4\n\n', 'tok-4\n'],
            ['no-newline.token', 'tok-5', 'tok-5'],
            ['cr-only.token', 'tok-6\r', 'tok-6\r'],
        ];
        for (const [name, content, expected] of cases) {
            writeFileSync(path.join(baseDir, name), content);
            const result = await resolver.resolve(parseSecretRef(`file:${name}`));
            assert.equal(result.value, expected);
            assert.equal(result.kind, 'file');
            assert.equal(result.refString, `file:${name}`);
        }
        writeFileSync(path.join(baseDir, 'only-newline.token'), '\n');
        await assert.rejects(resolver.resolve(parseSecretRef('file:only-newline.token')), (error: unknown) =>
            error instanceof SecretResolutionError && error.code === 'ERR_SECRET_UNRESOLVABLE');
        writeFileSync(path.join(baseDir, 'empty.token'), '');
        await assert.rejects(resolver.resolve(parseSecretRef('file:empty.token')), (error: unknown) =>
            error instanceof SecretResolutionError && error.code === 'ERR_SECRET_UNRESOLVABLE');
    });
});

test('file references reject traversal and absolute escapes', async () => {
    await withSecretsDir(async (baseDir, dir) => {
        writeFileSync(path.join(dir, 'outside.txt'), 'outside-value');
        const resolver = createSecretRefResolver({env: envOf({}), fs: nodeFileSystem(), baseDir});
        const escapingPaths = [
            '../outside.txt',
            'sub/../../outside.txt',
            path.join(dir, 'outside.txt'),
        ];
        for (const filePath of escapingPaths) {
            const ref = parseSecretRef(`file:${filePath}`);
            await assert.rejects(resolver.resolve(ref), (error: unknown) =>
                error instanceof SecretResolutionError && error.code === 'ERR_SECRET_FILE_ESCAPE');
            assert.equal(resolver.has(ref), false);
        }
    });
});

test('file references reject symlinks that escape the trusted base', async () => {
    await withSecretsDir(async (baseDir, dir) => {
        writeFileSync(path.join(dir, 'outside.txt'), 'outside-value');
        symlinkSync(path.join(dir, 'outside.txt'), path.join(baseDir, 'leak-link'));
        symlinkSync(path.join(dir, 'ghost.txt'), path.join(baseDir, 'dead-link'));
        writeFileSync(path.join(baseDir, 'inner.token'), 'inner-value\n');
        symlinkSync(path.join(baseDir, 'inner.token'), path.join(baseDir, 'inner-link'));

        const resolver = createSecretRefResolver({env: envOf({}), fs: nodeFileSystem(), baseDir});
        await assert.rejects(resolver.resolve(parseSecretRef('file:leak-link')), (error: unknown) =>
            error instanceof SecretResolutionError && error.code === 'ERR_SECRET_FILE_ESCAPE');
        assert.equal(resolver.has(parseSecretRef('file:leak-link')), false);
        await assert.rejects(resolver.resolve(parseSecretRef('file:dead-link')), (error: unknown) =>
            error instanceof SecretResolutionError && error.code === 'ERR_SECRET_FILE_NOT_FOUND');
        const inner = await resolver.resolve(parseSecretRef('file:inner-link'));
        assert.equal(inner.value, 'inner-value');
    });
});

test('file references reject oversized secrets before reading', async () => {
    await withSecretsDir(async (baseDir) => {
        const resolver = createSecretRefResolver({env: envOf({}), fs: nodeFileSystem(), baseDir, maxBytes: 4});
        writeFileSync(path.join(baseDir, 'big.token'), '12345');
        await assert.rejects(resolver.resolve(parseSecretRef('file:big.token')), (error: unknown) =>
            error instanceof SecretResolutionError && error.code === 'ERR_SECRET_FILE_TOO_LARGE');
        assert.equal(resolver.has(parseSecretRef('file:big.token')), false);
        writeFileSync(path.join(baseDir, 'ok.token'), '1234');
        assert.equal((await resolver.resolve(parseSecretRef('file:ok.token'))).value, '1234');
    });
});

test('file references reject directories and permissive modes deterministically with an injected fs', async () => {
    const resolver = createSecretRefResolver({
        env: envOf({}),
        fs: fakeFileSystem(fakeStore),
        baseDir: '/fake/secrets',
        requirePrivateFileMode: true,
        maxBytes: 32,
    });
    await assert.rejects(resolver.resolve(parseSecretRef('file:sub')), (error: unknown) =>
        error instanceof SecretResolutionError && error.code === 'ERR_SECRET_FILE_NOT_REGULAR');
    assert.equal(resolver.has(parseSecretRef('file:sub')), false);
    await assert.rejects(resolver.resolve(parseSecretRef('file:loose.token')), (error: unknown) =>
        error instanceof SecretResolutionError && error.code === 'ERR_SECRET_FILE_PERMISSIVE_MODE');
    assert.equal(resolver.has(parseSecretRef('file:loose.token')), false);
    assert.equal((await resolver.resolve(parseSecretRef('file:private.token'))).value, 'private-value');
    await assert.rejects(resolver.resolve(parseSecretRef('file:.')), (error: unknown) =>
        error instanceof SecretResolutionError && error.code === 'ERR_SECRET_FILE_ESCAPE');
});

test('file references enforce restrictive POSIX modes only when requested', async () => {
    await withSecretsDir(async (baseDir) => {
        writeFileSync(path.join(baseDir, 'loose.token'), 'loose-value');
        chmodSync(path.join(baseDir, 'loose.token'), 0o644);
        writeFileSync(path.join(baseDir, 'private.token'), 'private-value');
        chmodSync(path.join(baseDir, 'private.token'), 0o600);

        const strict = createSecretRefResolver({
            env: envOf({}),
            fs: nodeFileSystem(),
            baseDir,
            requirePrivateFileMode: true,
        });
        await assert.rejects(strict.resolve(parseSecretRef('file:loose.token')), (error: unknown) =>
            error instanceof SecretResolutionError && error.code === 'ERR_SECRET_FILE_PERMISSIVE_MODE');
        assert.equal(strict.has(parseSecretRef('file:loose.token')), false);
        assert.equal((await strict.resolve(parseSecretRef('file:private.token'))).value, 'private-value');

        const permissive = createSecretRefResolver({env: envOf({}), fs: nodeFileSystem(), baseDir});
        assert.equal((await permissive.resolve(parseSecretRef('file:loose.token'))).value, 'loose-value');
    });
});

test('resolved values never appear in errors or descriptions', async () => {
    const sensitive = 'sk-SUPER-SECRET-42';
    await withSecretsDir(async (baseDir, dir) => {
        writeFileSync(path.join(dir, 'outside.txt'), `${sensitive}\n`);
        symlinkSync(path.join(dir, 'outside.txt'), path.join(baseDir, 'leak-link'));
        writeFileSync(path.join(baseDir, 'loose.token'), sensitive);
        chmodSync(path.join(baseDir, 'loose.token'), 0o666);
        const resolver = createSecretRefResolver({
            env: envOf({}),
            fs: nodeFileSystem(),
            baseDir,
            requirePrivateFileMode: true,
        });
        const failing = [
            () => resolver.resolve(parseSecretRef('file:leak-link')),
            () => resolver.resolve(parseSecretRef('file:loose.token')),
            () => resolver.resolve(parseSecretRef('file:../outside.txt')),
            () => resolver.resolve(parseSecretRef('env:NEVER_SET')),
            () => resolver.resolve(parseSecretRef('file:missing.token')),
        ];
        for (const attempt of failing) {
            const error = await attempt().then(() => null, (cause: unknown) => cause);
            assert.ok(error instanceof SecretResolutionError);
            assert.equal(error.message.includes(sensitive), false);
            assert.equal(error.refString.includes(sensitive), false);
            assert.match(error.message, /: file:|: env:/);
        }
        assert.equal(resolver.describe(parseSecretRef('file:leak-link')).includes(sensitive), false);
        assert.equal(resolver.describe(parseSecretRef('env:NEVER_SET')).includes(sensitive), false);

        const open = createSecretRefResolver({env: envOf({}), fs: nodeFileSystem(), baseDir});
        const resolved = await open.resolve(parseSecretRef('file:loose.token'));
        assert.equal(resolved.value, sensitive);
        assert.equal(resolved.digest, sha256Hex(sensitive));
    });
});

test('describe yields deterministic reference metadata without values', () => {
    const resolver = createSecretRefResolver({
        env: envOf({SOME_ENV: 'secret-value'}),
        fs: fakeFileSystem(fakeStore),
        baseDir: '/fake/secrets',
    });
    const envDescription = resolver.describe(parseSecretRef('env:SOME_ENV'));
    assert.equal(envDescription, 'resolved from environment SOME_ENV');
    assert.equal(envDescription.includes('secret-value'), false);
    const fileDescription = resolver.describe(parseSecretRef('file:nested/key.token'));
    assert.equal(fileDescription, 'resolved from file nested/key.token');
    assert.equal(fileDescription.includes('secret-value'), false);
    assert.equal(resolver.describe(parseSecretRef('env:SOME_ENV')), envDescription);
    assert.equal(resolver.describe(parseSecretRef('file:nested/key.token')), fileDescription);
});

test('concurrent resolves are isolated, deterministic, and fail closed', async () => {
    const resolver = createSecretRefResolver({
        env: envOf({CONCUR_A: 'alpha', CONCUR_B: 'beta'}),
        fs: fakeFileSystem(fakeStore),
        baseDir: '/fake/secrets',
    });
    const refs = [
        () => parseSecretRef('env:CONCUR_A'),
        () => parseSecretRef('env:CONCUR_B'),
        () => parseSecretRef('file:agent.token'),
        () => parseSecretRef('file:nested/key.token'),
    ];
    const expected = ['alpha', 'beta', 'from-fake-fs', 'nested-key'];
    const outcomes = await Promise.all(Array.from({length: 40}, (_unused, index) => {
        const slot = index % refs.length;
        return resolver.resolve(refs[slot]()).then((result) => ({slot, result}));
    }));
    for (const {slot, result} of outcomes) {
        assert.equal(result.value, expected[slot]);
        assert.equal(result.digest, sha256Hex(expected[slot]));
    }
    for (let i = 0; i < 20; i += 1) {
        await assert.rejects(resolver.resolve(parseSecretRef('file:../escape')), (error: unknown) =>
            error instanceof SecretResolutionError && error.code === 'ERR_SECRET_FILE_ESCAPE');
    }
});

test('resolution is driven by injected environment and filesystem', async () => {
    const resolver = createSecretRefResolver({
        env: envOf({INJECTED_TOKEN: 'injected-value'}),
        fs: fakeFileSystem(fakeStore),
        baseDir: '/fake/secrets',
    });
    const envResult = await resolver.resolve(parseSecretRef('env:INJECTED_TOKEN'));
    assert.equal(envResult.value, 'injected-value');
    assert.equal(envResult.source, 'resolved from environment INJECTED_TOKEN');
    const fileResult = await resolver.resolve(parseSecretRef('file:agent.token'));
    assert.equal(fileResult.value, 'from-fake-fs');
    assert.equal(fileResult.refString, 'file:agent.token');
    assert.equal(fileResult.source, 'resolved from file agent.token');
    const nested = await resolver.resolve(parseSecretRef('file:nested/key.token'));
    assert.equal(nested.value, 'nested-key');
});

test('credential resolver adapter bridges secret refs without changing security primitives', async () => {
    await withSecretsDir(async (baseDir) => {
        writeFileSync(path.join(baseDir, 'agent.token'), 'tok-xyz\n');
        const resolver = createSecretRefResolver({
            env: envOf({API_TOKEN: 'env-token-value'}),
            fs: nodeFileSystem(),
            baseDir,
        });
        const credentials = credentialResolverFromSecretRefResolver(resolver);

        const envRef = credentialRefForEnv('API_TOKEN');
        assert.equal(credentials.has(envRef), true);
        assert.equal(await credentials.resolve(envRef), 'env-token-value');
        assert.equal(credentials.describe(envRef), 'resolved from environment API_TOKEN');

        const fileRef = createCredentialRef({id: 'file:agent.token', kind: 'secret'});
        assert.equal(await credentials.resolve(fileRef), 'tok-xyz');
        assert.equal(credentials.has(fileRef), true);

        const missing = credentialRefForEnv('NEVER_SET');
        assert.equal(credentials.has(missing), false);
        await assert.rejects(credentials.resolve(missing), (error: unknown) =>
            error instanceof SecurityError && error.code === 'ERR_SECURITY_CREDENTIAL_NOT_FOUND');

        const escaping = createCredentialRef({id: 'file:../outside', kind: 'secret'});
        await assert.rejects(credentials.resolve(escaping), (error: unknown) =>
            error instanceof SecurityError && error.code === 'ERR_SECURITY_CREDENTIAL_UNRESOLVABLE');

        const plain = createCredentialRef({id: 'opaque-key', kind: 'credential'});
        assert.equal(credentials.has(plain), false);
        assert.equal(credentials.describe(plain), 'credential:opaque-key');
        await assert.rejects(credentials.resolve(plain), (error: unknown) =>
            error instanceof SecurityError && error.code === 'ERR_SECURITY_CREDENTIAL_UNRESOLVABLE');
    });
});