import { Card, Modal, Space, Tag, Typography, message } from 'antd';
import { useMemo, useState } from 'react';
import { BusinessForm } from '../../component/entity-rules/BusinessForm';
import { BusinessTable, type OrderRowAction } from '../../component/entity-rules/BusinessTable';
import { PaginationBar } from '../../component/entity-rules/PaginationBar';
import { TaskBanner } from '../../component/entity-rules/TaskBanner';
import { getOrderListFixture } from '../../service/entity-rules/fixture-service';
import type { OrderRecord } from '../../types/entity-rules';

const PAGE_SIZE = 10;

export const FixtureOrderList = () => {
    const fixture = getOrderListFixture();
    const [filters, setFilters] = useState({ orderNo: '', buyer: '', status: '全部' });
    const [appliedFilters, setAppliedFilters] = useState({ orderNo: '', buyer: '', status: '全部' });
    const [page, setPage] = useState(1);
    const [dialog, setDialog] = useState<{ open: boolean; action?: OrderRowAction; row?: OrderRecord }>({ open: false });

    const filteredRows = useMemo(() => {
        return fixture.rows.filter((row) => {
            if (appliedFilters.orderNo && !row.orderNo.includes(appliedFilters.orderNo)) return false;
            if (appliedFilters.buyer && !row.buyer.includes(appliedFilters.buyer)) return false;
            if (appliedFilters.status !== '全部' && row.status !== appliedFilters.status) return false;
            return true;
        });
    }, [appliedFilters, fixture.rows]);

    const pageRows = useMemo(() => {
        const start = (page - 1) * PAGE_SIZE;
        return filteredRows.slice(start, start + PAGE_SIZE);
    }, [filteredRows, page]);

    return (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <TaskBanner title="订单列表夹具页" description="用于 entity_rules 列表场景命中和 golden verify。" />
            <Card title="订单筛选">
                <BusinessForm
                    mode="list"
                    values={filters}
                    onChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
                    onSubmit={() => {
                        const next = { ...filters };
                        const matched = fixture.rows.filter((row) => {
                            if (next.orderNo && !row.orderNo.includes(next.orderNo)) return false;
                            if (next.buyer && !row.buyer.includes(next.buyer)) return false;
                            if (next.status !== '全部' && row.status !== next.status) return false;
                            return true;
                        });
                        setAppliedFilters(next);
                        setPage(1);
                        message.success(`查询完成，共筛选到 ${matched.length} 条`);
                    }}
                    onReset={() => {
                        const next = { orderNo: '', buyer: '', status: '全部' };
                        setFilters(next);
                        setAppliedFilters(next);
                        setPage(1);
                        message.info('已重置筛选条件');
                    }}
                />
            </Card>

            <Card
                title="订单列表"
                role="table"
                aria-label="订单主表格"
                extra={<Tag color="blue">当前筛选 {filteredRows.length} 条</Tag>}
            >
                <BusinessTable
                    rows={pageRows}
                    onAction={(action, row) => {
                        if (action === 'delete') {
                            message.warning(`夹具页不执行真实删除：${row.orderNo}`);
                            return;
                        }
                        setDialog({ open: true, action, row });
                    }}
                />
                <PaginationBar page={page} pageSize={PAGE_SIZE} total={filteredRows.length} onChange={(nextPage) => setPage(nextPage)} />
            </Card>

            <Modal
                open={dialog.open}
                title={dialog.action === 'view' ? '订单详情' : '编辑订单'}
                onCancel={() => setDialog({ open: false })}
                onOk={() => setDialog({ open: false })}
                okText="确定"
                cancelText="关闭"
            >
                {dialog.row ? (
                    <Space direction="vertical">
                        <Typography.Text>订单编号：{dialog.row.orderNo}</Typography.Text>
                        <Typography.Text>采购人：{dialog.row.buyer}</Typography.Text>
                        <Typography.Text>金额：￥{dialog.row.amount.toLocaleString('zh-CN')}</Typography.Text>
                        <Typography.Text>状态：{dialog.row.status}</Typography.Text>
                    </Space>
                ) : null}
            </Modal>
        </Space>
    );
};
