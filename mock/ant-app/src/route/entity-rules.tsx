import type { RouteObject } from 'react-router-dom';
import { BenchOrderForm } from '../view/entity-rules/BenchOrderForm';
import { BenchOrderList } from '../view/entity-rules/BenchOrderList';
import { EntityRulesHome } from '../view/entity-rules/EntityRulesHome';
import { FixtureOrderForm } from '../view/entity-rules/FixtureOrderForm';
import { FixtureOrderList } from '../view/entity-rules/FixtureOrderList';

export const entityRuleRoutes: RouteObject[] = [
    { path: '/entity-rules', element: <EntityRulesHome /> },
    { path: '/entity-rules/fixtures/order-list', element: <FixtureOrderList /> },
    { path: '/entity-rules/fixtures/order-form', element: <FixtureOrderForm /> },
    { path: '/entity-rules/bench/order-list/:caseId', element: <BenchOrderList /> },
    { path: '/entity-rules/bench/order-form/:caseId', element: <BenchOrderForm /> },
    { path: '*', element: <EntityRulesHome /> },
];
