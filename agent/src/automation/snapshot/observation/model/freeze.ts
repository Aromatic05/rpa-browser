export const deepFreeze = <T>(value: T): T => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
        return value;
    }

    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
        deepFreeze(child);
    }
    return value;
};
