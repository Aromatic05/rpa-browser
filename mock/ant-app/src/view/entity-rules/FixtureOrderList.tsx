import { Card, Space, message } from 'antd';
import { useMemo, useState } from 'react';
import { BusinessForm } from '../../component/entity-rules/BusinessForm';
import { BusinessTable } from '../../component/entity-rules/BusinessTable';
import { PaginationBar } from '../../component/entity-rules/PaginationBar';
import { TaskBanner } from '../../component/entity-rules/TaskBanner';
import { getOrderListFixture } from '../../service/entity-rules/fixture-service';

export const FixtureOrderList = () => {
    const fixture = getOrderListFixture();
    const [filters, setFilters] = useState({ orderNo: '', buyer: '', status: '全部' });
    const [appliedFilters, setAppliedFilters] = useState({ orderNo: '', buyer: '', status: '全部' });

    const rows = useMemo(() => {
        return fixture.rows.filter((row) => {
            if (appliedFilters.orderNo && !row.orderNo.includes(appliedFilters.orderNo)) return false;
            if (appliedFilters.buyer && !row.buyer.includes(appliedFilters.buyer)) return false;
            if (appliedFilters.status !== '全部' && row.status !== appliedFilters.status) return false;
            return true;
        });
    }, [appliedFilters, fixture.rows]);

    return (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <TaskBanner title="订单列表夹具页" description="用于 entity_rules 列表场景命中和 golden verify。" />
            <Card title="订单筛选">
                <BusinessForm
                    mode="list"
                    values={filters}
                    onChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
                    onSubmit={() => {
                        const matched = fixture.rows.filter((row) => {
                            if (filters.orderNo && !row.orderNo.includes(filters.orderNo)) return false;
                            if (filters.buyer && !row.buyer.includes(filters.buyer)) return false;
                            if (filters.status !== '全部' && row.status !== filters.status) return false;
                            return true;
                        });
                        setAppliedFilters(filters);
                        message.success(`查询完成，共 ${matched.length} 条`);
                    }}
                    onReset={() => {
                        const next = { orderNo: '', buyer: '', status: '全部' };
                        setFilters(next);
                        setAppliedFilters(next);
                        message.info('已重置筛选条件');
                    }}
                />
            </Card>
            <Card title="订单列表" role="table" aria-label="订单主表格">
                <BusinessTable
                    rows={rows}
                    onAction={(action, row) => {
                        if (action === 'delete') {
                            message.warning(`已标记删除 ${row.orderNo}`);
                            return;
                        }
                        message.info(`${action === 'view' ? '查看' : '编辑'} ${row.orderNo}`);
                    }}
                />
                <PaginationBar page={fixture.pagination.page} pageSize={fixture.pagination.pageSize} total={fixture.pagination.total} />
            </Card>
        </Space>
    );
};
