# Configuring the ChatGPT Plugin

1. Enable developer mode when available/required by the account.
2. In ChatGPT Plugins add a custom MCP connection named **Home Assistant ChatGPT Gateway Plugin**.
3. Set `https://gateway.example.com/mcp`, OAuth and manual/preregistered client credentials.
4. Use Client ID `ha-chatgpt` and the generated Client Secret directly in the settings.
5. Copy the exact callback from ChatGPT into the provider allowlist; never use a wildcard.
6. Sign in to Keycloak with the owner account and replace its temporary password.
7. Connect/refresh tools, start a new chat, select the plugin and test health/read operations.
8. Package the supplied skill with your own verified registered app mapping.

Exporting the newly created connection does not automatically include the skill. Keep personal app IDs and credentials out of public packages.
Use the [256 px icon](https://github.com/aferende/ha-chatgpt-gateway/blob/main/assets/plugin-icon-256.png) for the plugin.

The English skill instructions are in [SKILL.md](https://github.com/aferende/ha-chatgpt-gateway/blob/main/plugin/skills/home-assistant/SKILL.md). They cover discovery, safe explicit targets, capabilities, batches, history and asynchronous outcomes.
[Official OpenAI setup](https://developers.openai.com/plugins/deploy/connect-chatgpt)
