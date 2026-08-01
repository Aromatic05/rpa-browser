
use entity_rules "dsl-login-rule" as auth
fill auth.loginForm.username with input.username
fill auth.loginForm.password with input.password
click auth.loginForm.submit
output authenticatedUser = input.username
