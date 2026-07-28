/**
 * Snapshot-scoped entity-rule contracts and component target bridges.
 *
 * Match cardinality is preserved independently from archived V1 region/group
 * entities. Form rules receive only FormComponent or canonical-node targets.
 */
export * from './contracts';
export * from './cardinality';
export * from './form_bridge';
