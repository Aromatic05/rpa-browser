import type {
    SnapshotProjectionBaseline,
    SnapshotProjectionBaselinePort,
} from '../../snapshot/projection/contracts';

export class SnapshotProjectionBaselineStore<Key extends object = object>
implements SnapshotProjectionBaselinePort<Key> {
    private readonly baselines = new WeakMap<Key, Map<string, SnapshotProjectionBaseline>>();

    public read(pageKey: Key, key: string): SnapshotProjectionBaseline | undefined {
        const baseline = this.baselines.get(pageKey)?.get(key);
        return baseline ? structuredClone(baseline) : undefined;
    }

    public write(pageKey: Key, baseline: SnapshotProjectionBaseline): void {
        const current = this.baselines.get(pageKey) ?? new Map<string, SnapshotProjectionBaseline>();
        current.set(baseline.key, structuredClone(baseline));
        this.baselines.set(pageKey, current);
    }

    public clear(pageKey: Key): void {
        this.baselines.delete(pageKey);
    }
}
