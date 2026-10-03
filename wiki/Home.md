# Home Assistant ChatGPT Gateway Plugin

Open-source, self-hosted Home Assistant discovery and control through MCP and Keycloak OAuth. The Home Assistant token stays on the gateway host; no OpenAI API key is needed. Tool results are still processed by ChatGPT.

## v0.7.0 breaking integration change

Custom GPT Actions/API keys do not migrate automatically into a plugin. New deployments are MCP-only. Legacy REST remains optional.
[Migration](Migrating-to-v0.7.0) · [Getting started](Getting-Started) · [Keycloak](Keycloak-OAuth) · [Plugin setup](Configuring-the-ChatGPT-Plugin)

OpenAI schedules custom GPT retirement for December 11, 2026; February 11, 2027 applies only to eligible approved Enterprise deferrals. See the [official FAQ](https://help.openai.com/en/articles/20001519-custom-gpt-retirement-and-migration-faq).

## Guides

- [Configuration](Configuration-Guide)
- [Docker and NAS deployment](Deploying-the-Gateway)
- [Home Assistant credentials](Connecting-Home-Assistant)
- [Examples](Usage-Examples)
- [Troubleshooting](Troubleshooting)
- [Legacy GPT Action](Configuring-the-ChatGPT-Action)

[README](https://github.com/aferende/ha-chatgpt-gateway#readme) · [Security](https://github.com/aferende/ha-chatgpt-gateway/blob/main/docs/security.md) · [Releases](https://github.com/aferende/ha-chatgpt-gateway/releases)
