import { Button, Space, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { OrderRecord } from '../../types/entity-rules';

export type OrderRowAction = 'view' | 'edit' | 'delete';

export const BusinessTable = ({
    rows,
    onAction,
}: {
    rows: OrderRecord[];
    onAction?: (action: OrderRowAction, row: OrderRecord) => void;
}) => {
    const columns: ColumnsType<OrderRecord> = [
        { title: '订单编号', dataIndex: 'orderNo', key: 'orderNo' },
        { title: '采购人', dataIndex: 'buyer', key: 'buyer' },
        { title: '金额', dataIndex: 'amount', key: 'amount', render: (value: number) => `￥${value.toLocaleString('zh-CN')}` },
        { title: '状态', dataIndex: 'status', key: 'status' },
        {
            title: '操作',
            key: 'actions',
            render: (_, row) => (
                <Space>
                    <Button onClick={() => onAction?.('view', row)}>查看</Button>
                    <Button onClick={() => onAction?.('edit', row)}>编辑</Button>
                    <Button danger onClick={() => onAction?.('delete', row)}>
                        删除
                    </Button>
                </Space>
            ),
        },
    ];

    return <Table rowKey="orderNo" columns={columns} dataSource={rows} pagination={false} />;
};
