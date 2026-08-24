import type { ControlCollector, ControlCollectorContext, ControlCollectorRegistryPort } from '../model/contracts';

export class ControlCollectorRegistry implements ControlCollectorRegistryPort {
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
