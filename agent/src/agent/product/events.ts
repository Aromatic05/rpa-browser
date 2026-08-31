import type {ProductEvent, ProductEventsResponse} from './types';

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export type ProductEventSink = Readonly<{
    append: (taskId: string, event: DistributiveOmit<ProductEvent, 'seq' | 'taskId' | 'at'>) => number;
    eventsAfter: (taskId: string, afterSeq: number) => ProductEventsResponse;
    lastSeq: (taskId: string) => number;
    reset: () => void;
}>;

export const createProductEventLog = (now: () => number = Date.now): ProductEventSink => {
    const counters = new Map<string, number>();
    const logs = new Map<string, Array<ProductEvent>>();

    const append: ProductEventSink['append'] = (taskId, event) => {
        const seq = (counters.get(taskId) ?? 0) + 1;
        counters.set(taskId, seq);
        const record: ProductEvent = Object.freeze({
            ...event,
            seq,
            taskId,
            at: now(),
        });
        const entries = logs.get(taskId) ?? [];
        entries.push(record);
        logs.set(taskId, entries);
        return seq;
    };

    const eventsAfter: ProductEventSink['eventsAfter'] = (taskId, afterSeq) => {
        const entries = logs.get(taskId) ?? [];
        const events = entries.filter((event) => event.seq > afterSeq);
        const nextSeq = counters.get(taskId) ?? 0;
        const first = events[0];
        return Object.freeze({
            events: Object.freeze([...events]),
            nextSeq,
            gap: events.length > 0
                ? first.seq !== afterSeq + 1
                : afterSeq > nextSeq,
        });
    };

    const lastSeq: ProductEventSink['lastSeq'] = (taskId) => counters.get(taskId) ?? 0;

    return {
        append,
        eventsAfter,
        lastSeq,
        reset: () => {
            counters.clear();
            logs.clear();
        },
    };
};