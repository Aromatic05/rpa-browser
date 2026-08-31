import {AGENT_EVAL_SCENARIO_CONTRACT_VERSION} from './contracts';
import type {
    AgentEvalMode,
    AgentEvalScenario,
} from './contracts';

export const isAgentEvalScenario = (value: unknown): value is AgentEvalScenario => {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    return candidate.version === AGENT_EVAL_SCENARIO_CONTRACT_VERSION
        && typeof candidate.id === 'string'
        && typeof candidate.name === 'string'
        && Array.isArray(candidate.modes)
        && candidate.modes.every((mode): mode is AgentEvalMode => mode === 'program' || mode === 'react-baseline')
        && typeof candidate.trials === 'number'
        && Number.isInteger(candidate.trials)
        && candidate.trials >= 0
        && typeof candidate.task === 'object'
        && candidate.task !== null
        && typeof (candidate.task as {id?: unknown}).id === 'string';
};

export const scenarioMatchesQuery = (
    scenario: AgentEvalScenario,
    query?: string,
): boolean => {
    if (!query) {
        return true;
    }
    const normalized = query.toLowerCase();
    return scenario.id.toLowerCase().includes(normalized)
        || scenario.name.toLowerCase().includes(normalized)
        || (scenario.description?.toLowerCase().includes(normalized) ?? false);
};

export type FilterScenariosOptions = Readonly<{
    query?: string;
    modes?: readonly AgentEvalMode[];
}>;

/**
 * Filter a scenario registry and restrict modes/trials. The original scenarios
 * are not mutated; a shallow copy with adjusted modes is returned.
 */
export const filterScenarios = (
    scenarios: readonly AgentEvalScenario[],
    options: FilterScenariosOptions = {},
): AgentEvalScenario[] => {
    const matched = scenarios.filter((scenario) => scenarioMatchesQuery(scenario, options.query));
    if (!options.modes || options.modes.length === 0) {
        return [...matched];
    }
    return matched
        .map((scenario) => {
            const restrictedModes = scenario.modes.filter((mode) => options.modes!.includes(mode));
            if (restrictedModes.length === scenario.modes.length) {
                return scenario;
            }
            return {...scenario, modes: restrictedModes};
        })
        .filter((scenario) => scenario.modes.length > 0);
};
