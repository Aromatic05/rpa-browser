import type { ObservationNodeId, PageObservation, RelationIndex } from '../observation/contracts';
import type { LocatorIndex } from '../locator/contracts';
import type { ControlComponent } from './contracts';

export type ControlCollectorContext = {
    observation: PageObservation;
    relations: RelationIndex;
    locators: LocatorIndex;
    controls: Record<string, ControlComponent>;
    consumedNodeIds: Set<ObservationNodeId>;
};

export type ControlCollector = {
    id: string;
    collect: (context: ControlCollectorContext) => void;
};

export class ControlCollectorRegistry {
    readonly #collectors = new Map<string, ControlCollector>();

    register(collector: ControlCollector): this {
        const id = collector.id.trim();
        if (!id) {throw new Error('control collector id must be non-empty');}
        if (this.#collectors.has(id)) {throw new Error(`duplicate control collector: ${id}`);}
        this.#collectors.set(id, { ...collector, id });
        return this;
    }

    collect(context: ControlCollectorContext): void {
        for (const collector of this.#collectors.values()) {
            collector.collect(context);
        }
    }

    list(): readonly string[] {
        return [...this.#collectors.keys()];
    }
}
