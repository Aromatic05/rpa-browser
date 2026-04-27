import { fixtureOrderRows } from '../../data/entity-rules/fixtures/order-list';
import { fixtureOrderFormData } from '../../data/entity-rules/fixtures/order-form';

export const getOrderListFixture = () => ({
    rows: fixtureOrderRows,
    pagination: { page: 1, pageSize: 10, total: 120 },
});

export const getOrderFormFixture = () => ({ ...fixtureOrderFormData });
