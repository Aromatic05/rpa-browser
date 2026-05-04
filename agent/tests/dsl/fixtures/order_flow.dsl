use checkpoint "ensure_logged_in" with {
  username: input.username
}

let buyer = query entity.target "order.form" {
  kind: "form.field"
  fieldKey: "buyer"
}

for user in input.users:
  if user.enabled:
    fill buyer with user.name
