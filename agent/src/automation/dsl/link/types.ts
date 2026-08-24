import type {EffectDeclaration} from '../../../program/effects/contracts';

export type DslEntityRulesEntityKind = 'form' | 'table' | 'dialog' | 'list' | 'panel' | 'toolbar' | 'kv';

export type DslEntityRulesProfile = {
    profileName: string;
    entities: readonly {
        entityKey: string;
        businessTag: string;
        kind: DslEntityRulesEntityKind;
        fields: readonly {fieldKey: string; targetKind: 'form.field' | 'table.filter' | 'entity.field'; effect?: EffectDeclaration}[];
        actions: readonly {actionIntent: string; targetKind: 'form.action' | 'table.module_action' | 'entity.action'; effect?: EffectDeclaration}[];
        columns: readonly {fieldKey: string}[];
        rowActions: readonly {actionIntent: string; targetKind: 'table.row_action'; effect?: EffectDeclaration}[];
        supportedQueries: readonly string[];
        primaryKey?: {fieldKey: string};
    }[];
};

export type DslEntityRulesResolutionDiagnostic = {
    code: string;
    message: string;
};

export type DslEntityRulesProfileResolution = {
    profile: DslEntityRulesProfile | null;
    diagnostics: readonly DslEntityRulesResolutionDiagnostic[];
};

export type DslEntityRulesResolver = {
    resolveProfile: (profileName: string) => DslEntityRulesProfileResolution;
};

export type DslResolveBundleResolution = {
    resolves: Record<string, StepResolve> | null;
    diagnostics: readonly DslEntityRulesResolutionDiagnostic[];
};

export type DslResolveResolver = {
    resolveBundle: (bundleName: string) => DslResolveBundleResolution;
};
import type { StepResolve } from '../../runner/steps/types';
