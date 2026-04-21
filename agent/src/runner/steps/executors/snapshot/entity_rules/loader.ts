import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { getLogger } from '../../../../../logging/logger';
import { defaultEntityRuleConfig, selectEntityRuleProfiles, type EntityRuleProfileMeta } from '../../../../../config/entity_rules';
import type { LoadEntityRulesOptions, LoadEntityRulesResult, NormalizedEntityRuleBundle } from './types';
import { validateEntityRules } from './validate';

const log = getLogger('entity');
const MATCH_FILE = 'match.yaml';
const ANNOTATION_FILE = 'annotation.yaml';
const BUILTIN_PROFILE_DIR = path.resolve(process.cwd(), 'tests/entity_rules/profiles');

export const loadEntityRules = (options: LoadEntityRulesOptions = {}): LoadEntityRulesResult => {
    const config = options.config || defaultEntityRuleConfig;

    log.info('entity.rules.load.start', {
        enabled: config.enabled,
        selection: config.selection,
        strict: config.strict,
        rootDir: config.rootDir,
        profiles: config.profiles,
        pageKind: options.pageKind,
        pageUrl: options.pageUrl,
    });

    if (!config.enabled || config.selection === 'disabled') {
        log.info('entity.rules.load.end', { selectedProfile: null, reason: 'disabled' });
        return { errors: [], warnings: [] };
    }

    syncBuiltinProfilesToRuntime(config.rootDir);

    const profilesRootDir = path.join(config.rootDir, 'profiles');
    if (!fs.existsSync(profilesRootDir)) {
        const issue = `entity rules root not found: ${profilesRootDir}`;
        const result = resultWithIssue(config.strict, issue);
        log.info('entity.rules.load.end', {
            selectedProfile: null,
            reason: 'profiles_root_missing',
            errors: result.errors,
            warnings: result.warnings,
        });
        return result;
    }

    const entries = safeReadDir(profilesRootDir)
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));

    const loadedBundles: NormalizedEntityRuleBundle[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const profileName of entries) {
        const loaded = loadProfileBundle(profilesRootDir, profileName);
        if (loaded.ok) {
            loadedBundles.push(loaded.bundle);
            continue;
        }

        for (const issue of loaded.issues) {
            const message = `entity_rules/${profileName}: ${issue}`;
            if (config.strict) {
                errors.push(message);
            } else {
                warnings.push(message);
            }
            log.warn('entity.rules.validate.failed', {
                profile: profileName,
                issue: message,
            });
        }
    }

    const profileMetas: EntityRuleProfileMeta[] = loadedBundles.map((bundle) => ({
        name: bundle.id,
        pageKind: bundle.page.kind,
        urlPattern: bundle.page.urlPattern,
    }));

    const selected = selectEntityRuleProfiles(config, profileMetas, {
        kind: options.pageKind,
        url: options.pageUrl,
    });
    errors.push(...selected.errors);
    warnings.push(...selected.warnings);

    if (selected.selected.length > 1) {
        log.warn('entity.rules.profile.conflict', {
            selection: config.selection,
            profiles: selected.selected,
            pageKind: options.pageKind,
            pageUrl: options.pageUrl,
        });
    }

    const selectedProfile = selected.selected[0];
    if (selectedProfile) {
        log.info('entity.rules.profile.selected', {
            selection: config.selection,
            profile: selectedProfile,
            pageKind: options.pageKind,
            pageUrl: options.pageUrl,
        });
    }

    const bundle = selectedProfile ? loadedBundles.find((item) => item.id === selectedProfile) : undefined;

    if (selectedProfile && !bundle) {
        const issue = `entity profile not loaded: ${selectedProfile}`;
        if (config.strict) {
            errors.push(issue);
        } else {
            warnings.push(issue);
        }
    }

    log.info('entity.rules.load.end', {
        selectedProfile: selectedProfile || null,
        errors: errors.length,
        warnings: warnings.length,
    });

    return {
        bundle,
        selectedProfile,
        errors,
        warnings,
    };
};

const syncBuiltinProfilesToRuntime = (rootDir: string) => {
    if (!fs.existsSync(BUILTIN_PROFILE_DIR)) return;

    const runtimeProfilesDir = path.join(rootDir, 'profiles');
    try {
        fs.rmSync(runtimeProfilesDir, { recursive: true, force: true });
        fs.mkdirSync(runtimeProfilesDir, { recursive: true });
        fs.cpSync(BUILTIN_PROFILE_DIR, runtimeProfilesDir, { recursive: true });
    } catch (error) {
        log.warn('entity.rules.validate.failed', {
            profile: '__builtin_sync__',
            issue: error instanceof Error ? error.message : 'failed to sync builtin profiles',
        });
    }
};

const loadProfileBundle = (
    profilesRootDir: string,
    profileName: string,
): { ok: true; bundle: NormalizedEntityRuleBundle } | { ok: false; issues: string[] } => {
    const profileDir = path.join(profilesRootDir, profileName);
    const matchPath = path.join(profileDir, MATCH_FILE);
    const annotationPath = path.join(profileDir, ANNOTATION_FILE);

    if (!fs.existsSync(matchPath) || !fs.existsSync(annotationPath)) {
        return {
            ok: false,
            issues: [`missing ${MATCH_FILE} or ${ANNOTATION_FILE}`],
        };
    }

    const matchParsed = parseYamlFile(matchPath);
    if (!matchParsed.ok) {
        return {
            ok: false,
            issues: [`${MATCH_FILE}: ${matchParsed.error}`],
        };
    }

    const annotationParsed = parseYamlFile(annotationPath);
    if (!annotationParsed.ok) {
        return {
            ok: false,
            issues: [`${ANNOTATION_FILE}: ${annotationParsed.error}`],
        };
    }

    const validated = validateEntityRules(profileName, matchParsed.data, annotationParsed.data);
    if (!validated.ok) {
        return {
            ok: false,
            issues: validated.errors,
        };
    }

    return {
        ok: true,
        bundle: validated.bundle,
    };
};

const parseYamlFile = (filePath: string): { ok: true; data: unknown } | { ok: false; error: string } => {
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = parse(raw);
        return { ok: true, data };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'unknown parse error',
        };
    }
};

const safeReadDir = (dirPath: string) => {
    try {
        return fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
        return [];
    }
};

const resultWithIssue = (strict: boolean, issue: string): LoadEntityRulesResult => {
    if (strict) {
        return { errors: [issue], warnings: [] };
    }
    return { errors: [], warnings: [issue] };
};
