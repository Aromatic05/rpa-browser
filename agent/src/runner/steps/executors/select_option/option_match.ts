import type { SelectOptionOption, SelectOptionMatchResult } from './types';
import type { StepResult } from '../../types';
import { notFound, ambiguous, isStepResult } from './assert';

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const isMatch = (option: SelectOptionOption, target: string): boolean => {
    const raw = target;
    const trimmed = target.trim();
    const collapsed = collapseWhitespace(target);
    const lowered = collapsed.toLowerCase();

    const fields: (string | undefined)[] = [
        option.value,
        option.label,
        option.text,
        option.ariaLabel,
        option.title,
        option.dataValue,
        option.dataKey,
    ];

    for (const field of fields) {
        if (!field) {continue;}
        if (field === raw) {return true;}
        if (field.trim() === trimmed) {return true;}
        if (collapseWhitespace(field) === collapsed) {return true;}
        if (collapseWhitespace(field).toLowerCase() === lowered) {return true;}
    }
    return false;
};

export const matchOption = (
    stepId: string,
    options: SelectOptionOption[],
    targetValue: string,
): SelectOptionMatchResult | StepResult => {
    const matches: SelectOptionMatchResult[] = [];
    for (let i = 0; i < options.length; i += 1) {
        if (isMatch(options[i], targetValue)) {
            matches.push({ option: options[i], index: i });
        }
    }
    if (matches.length === 0) {
        return notFound(stepId, 'option not found', {
            targetValue,
            optionCount: options.length,
        });
    }
    if (matches.length > 1) {
        return ambiguous(stepId, 'multiple options matched', {
            targetValue,
            matchedValues: matches.map((m) => m.option.value),
            matchedLabels: matches.map((m) => m.option.label),
        });
    }
    return matches[0];
};

export const matchOptions = (
    stepId: string,
    options: SelectOptionOption[],
    targetValues: string[],
): SelectOptionMatchResult[] | StepResult => {
    const results: SelectOptionMatchResult[] = [];
    for (const value of targetValues) {
        const result = matchOption(stepId, options, value);
        if (isStepResult(result)) {return result;}
        results.push(result);
    }
    return results;
};
