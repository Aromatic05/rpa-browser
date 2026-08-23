
use entity_rules "dsl-orders-rule" as orders
use checkpoint "login-to-orders" with {
  username: input.username
  password: input.password
}
let rows = query orders.ordersTable.currentRows
for row in vars.rows:
  click orders.ordersTable.row(row.orderNo).approve
output processedRows = vars.rows
