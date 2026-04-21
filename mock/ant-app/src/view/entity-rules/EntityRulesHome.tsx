import { Card, List, Space, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { getOrderFormCaseOptions, getOrderListCaseOptions } from '../../service/entity-rules/case-service';

export const EntityRulesHome = () => {
    const fixtureLinks = [
        { to: '/entity-rules/fixtures/order-list', label: 'Fixture Order List' },
        { to: '/entity-rules/fixtures/order-form', label: 'Fixture Order Form' },
    ];
    const benchLinks = [
        ...getOrderListCaseOptions().map((item) => ({ to: `/entity-rules/bench/order-list/${item.id}`, label: `Bench Order List - ${item.title}` })),
        ...getOrderFormCaseOptions().map((item) => ({ to: `/entity-rules/bench/order-form/${item.id}`, label: `Bench Order Form - ${item.title}` })),
    ];

    return (
        <Space direction="vertical" style={{ width: '100%' }} size={16}>
            <Typography.Title level={2}>Ant Entity Rules Workspace</Typography.Title>
            <Card title="Fixtures">
                <List dataSource={fixtureLinks} renderItem={(item) => <List.Item><Link to={item.to}>{item.label}</Link></List.Item>} />
            </Card>
            <Card title="Benchmarks">
                <List dataSource={benchLinks} renderItem={(item) => <List.Item><Link to={item.to}>{item.label}</Link></List.Item>} />
            </Card>
        </Space>
    );
};
