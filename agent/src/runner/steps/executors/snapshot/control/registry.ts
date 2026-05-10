import type { ControlCollector, ControlRegistry } from './types';

export const createControlRegistry = (): ControlRegistry => ({
    collectors: [],
});

export const registerControlCollector = (
    registry: ControlRegistry,
    collector: ControlCollector,
): void => {
    registry.collectors.push(collector);
};

export const listControlCollectors = (registry: ControlRegistry): ControlCollector[] =>
    registry.collectors;
