# Migrating from v0.6.0 to v0.7.0

**Breaking integration change:** the main workflow moves from GPT Action/OpenAPI/API key to personal plugin/MCP/Keycloak. A schema import is not an MCP connection.

1. Back up the working image and private configuration.
2. Deploy the provider/database and final gateway, preserving the existing HTTPS hostname.
3. Bootstrap and connect OAuth; verify scopes, subject and roles.
4. Install the reusable skill and test representative conversations.
5. If no REST clients remain, set `ENABLE_LEGACY_REST_API=false` and remove old gateway API keys.
6. Confirm legacy routes are absent and old keys cannot authorize MCP.
7. Retire the old GPT/Action, then remove only unused project containers/images.
8. Preserve the current database, provider credentials and rollback image.

Do not delete the running gateway merely because it retains its old container name: the plugin uses it too.
Prefer rollback to the already tested MCP candidate. Do not re-enable retired credentials.
[Official retirement dates](https://help.openai.com/en/articles/20001519-custom-gpt-retirement-and-migration-faq) · [Release notes](https://github.com/aferende/ha-chatgpt-gateway/releases)
