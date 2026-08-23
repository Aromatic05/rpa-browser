import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {Stats} from 'node:fs';

export type DirectoryLockOwner = {
    pid: number;
    acquiredAt: number;
    token: string;
};

export type StaleDirectoryLockObservation = {
    generation: string;
};

type DirectoryIdentity = {
    dev: number;
    ino: number;
    birthtimeMs: number;
};

const OWNER_FILE = 'owner.json';
const OWNERLESS_GENERATION_FILE = '.reclaim-generation';

const isProcessAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
    }
};

const parseOwner = (source: string): DirectoryLockOwner | null => {
    try {
        const parsed = JSON.parse(source) as Partial<DirectoryLockOwner>;
        if (typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0
            || typeof parsed.acquiredAt !== 'number' || !Number.isFinite(parsed.acquiredAt)
            || typeof parsed.token !== 'string' || parsed.token.length === 0) {
            return null;
        }
        return parsed as DirectoryLockOwner;
    } catch {
        return null;
    }
};

export const readDirectoryLockOwnerSync = (lockDir: string): DirectoryLockOwner | null => {
    try {
        return parseOwner(fs.readFileSync(path.join(lockDir, OWNER_FILE), 'utf8'));
    } catch {
        return null;
    }
};

export const readDirectoryLockOwner = async (lockDir: string): Promise<DirectoryLockOwner | null> => {
    try {
        return parseOwner(await fsp.readFile(path.join(lockDir, OWNER_FILE), 'utf8'));
    } catch {
        return null;
    }
};

const identityOf = (stat: Stats): DirectoryIdentity => ({
    dev: stat.dev,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
});
const sameIdentity = (left: DirectoryIdentity, right: DirectoryIdentity): boolean =>
    left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;

const ownerGeneration = (owner: DirectoryLockOwner): string => `owner:${owner.token}`;
const ownerlessGeneration = (token: string): string => `ownerless:${token}`;

const readGenerationSync = (filePath: string): string | null => {
    try {
        const token = fs.readFileSync(filePath, 'utf8').trim();
        return token || null;
    } catch {
        return null;
    }
};

const readGeneration = async (filePath: string): Promise<string | null> => {
    try {
        const token = (await fsp.readFile(filePath, 'utf8')).trim();
        return token || null;
    } catch {
        return null;
    }
};

const ensureOwnerlessGenerationSync = (lockDir: string): string | null => {
    const filePath = path.join(lockDir, OWNERLESS_GENERATION_FILE);
    const existing = readGenerationSync(filePath);
    if (existing) {return existing;}
    const token = crypto.randomUUID();
    try {
        fs.writeFileSync(filePath, token, {encoding: 'utf8', flag: 'wx'});
        return token;
    } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
            return readGenerationSync(filePath);
        }
        return null;
    }
};

const ensureOwnerlessGeneration = async (lockDir: string): Promise<string | null> => {
    const filePath = path.join(lockDir, OWNERLESS_GENERATION_FILE);
    const existing = await readGeneration(filePath);
    if (existing) {return existing;}
    const token = crypto.randomUUID();
    try {
        await fsp.writeFile(filePath, token, {encoding: 'utf8', flag: 'wx'});
        return token;
    } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
            return await readGeneration(filePath);
        }
        return null;
    }
};

export const observeStaleDirectoryLockSync = (
    lockDir: string,
    staleMs: number,
): StaleDirectoryLockObservation | null => {
    const owner = readDirectoryLockOwnerSync(lockDir);
    if (owner) {
        return isProcessAlive(owner.pid) ? null : {generation: ownerGeneration(owner)};
    }

    let initialStat: Stats;
    try {
        initialStat = fs.statSync(lockDir);
    } catch {
        return null;
    }
    if (Date.now() - initialStat.mtimeMs <= staleMs) {return null;}
    const initialIdentity = identityOf(initialStat);
    const token = ensureOwnerlessGenerationSync(lockDir);
    if (!token) {return null;}
    const ownerAfterGeneration = readDirectoryLockOwnerSync(lockDir);
    if (ownerAfterGeneration) {
        return isProcessAlive(ownerAfterGeneration.pid)
            ? null
            : {generation: ownerGeneration(ownerAfterGeneration)};
    }
    try {
        if (!sameIdentity(initialIdentity, identityOf(fs.statSync(lockDir)))) {return null;}
    } catch {
        return null;
    }
    return {generation: ownerlessGeneration(token)};
};

export const observeStaleDirectoryLock = async (
    lockDir: string,
    staleMs: number,
): Promise<StaleDirectoryLockObservation | null> => {
    const owner = await readDirectoryLockOwner(lockDir);
    if (owner) {
        return isProcessAlive(owner.pid) ? null : {generation: ownerGeneration(owner)};
    }

    let initialStat: Stats;
    try {
        initialStat = await fsp.stat(lockDir);
    } catch {
        return null;
    }
    if (Date.now() - initialStat.mtimeMs <= staleMs) {return null;}
    const initialIdentity = identityOf(initialStat);
    const token = await ensureOwnerlessGeneration(lockDir);
    if (!token) {return null;}
    const ownerAfterGeneration = await readDirectoryLockOwner(lockDir);
    if (ownerAfterGeneration) {
        return isProcessAlive(ownerAfterGeneration.pid)
            ? null
            : {generation: ownerGeneration(ownerAfterGeneration)};
    }
    try {
        if (!sameIdentity(initialIdentity, identityOf(await fsp.stat(lockDir)))) {return null;}
    } catch {
        return null;
    }
    return {generation: ownerlessGeneration(token)};
};

const quarantinePath = (lockDir: string, observation: StaleDirectoryLockObservation): string => {
    const key = crypto.createHash('sha256').update(observation.generation).digest('hex');
    return path.join(`${lockDir}.reclaimed`, key);
};

// The generation-specific quarantine directory is intentionally retained as a tombstone.
// Removing it during normal lock acquisition would let a delayed stale observer rename a
// newer lock generation into the same destination and recreate the ABA race.

const isLostReclaimRace = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && 'code' in error
    && ['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(String(error.code));

export const reclaimObservedDirectoryLockSync = (
    lockDir: string,
    observation: StaleDirectoryLockObservation,
): boolean => {
    const destination = quarantinePath(lockDir, observation);
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    try {
        fs.renameSync(lockDir, destination);
        return true;
    } catch (error) {
        if (isLostReclaimRace(error)) {return false;}
        throw error;
    }
};

export const reclaimObservedDirectoryLock = async (
    lockDir: string,
    observation: StaleDirectoryLockObservation,
): Promise<boolean> => {
    const destination = quarantinePath(lockDir, observation);
    await fsp.mkdir(path.dirname(destination), {recursive: true});
    try {
        await fsp.rename(lockDir, destination);
        return true;
    } catch (error) {
        if (isLostReclaimRace(error)) {return false;}
        throw error;
    }
};
