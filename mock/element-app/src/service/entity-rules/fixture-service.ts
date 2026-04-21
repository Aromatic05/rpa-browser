import { fixtureUserRows } from '../../data/entity-rules/fixtures/user-list';
import { fixtureUserFormData } from '../../data/entity-rules/fixtures/user-form';

export const getUserListFixture = () => ({
    rows: fixtureUserRows,
    pagination: { page: 1, pageSize: 10, total: 60 },
});

export const getUserFormFixture = () => ({ ...fixtureUserFormData });
