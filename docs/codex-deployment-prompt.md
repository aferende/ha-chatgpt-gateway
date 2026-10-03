# One-prompt Codex deployment assistant

For Codex on Windows or Linux. Edit the non-secret configuration at the top. Supply credentials through private host files or secure environment values, never in a public repository or report.

```text
USER_CONFIGURATION
REPOSITORY=https://github.com/aferende/ha-chatgpt-gateway
VERSION=v0.7.0
DEPLOYMENT_HOST=<your Docker host or NAS>
DEPLOYMENT_DIRECTORY=<your project directory>
PUBLIC_GATEWAY_URL=https://gateway.example.com
HOME_ASSISTANT_URL=http://homeassistant.local:8123
SAFE_DOMAINS=light,switch
SAFE_ENTITIES=<reviewed harmless entities>
END_CONFIGURATION

Deploy Home Assistant ChatGPT Gateway Plugin from the specified official version.
Inspect existing files, architecture, Docker/Compose, containers and HTTPS proxy first.
Do not change unrelated stacks, volumes, networks or router rules.

Use the standard Keycloak/PostgreSQL stack and MCP-only gateway.
Separate .env from .env.keycloak; gateway containers must not receive provider
administrator/database credentials. Keep the Home Assistant token on the gateway
host only. Generate unique provider secrets locally and restrict file access.
Use pinned images, non-root/read-only gateway, tmpfs and no-new-privileges.

Configure HTTPS and exact proxy trust. Expose only the dedicated OAuth realm and
login assets, never provider admin/master/database or Home Assistant 8123.
If port forwarding is required, explain the TCP 443 rule and let me configure it.
Use the documented OAuth response-header buffers and avoid raw OAuth query logs.

Bootstrap the realm using the project helper, including basic/sub,
offline_access, PKCE S256 and independently checked read/write roles.
Use an exact ChatGPT callback, not a wildcard. Keep client secrets out of chat.

Start READ_ONLY=true with the reviewed safe policy. Verify metadata, OAuth,
MCP initialize/tools and actual Home Assistant reads. Guide my manual login,
temporary-password change and consent in ChatGPT.
Install/package the reusable skill with my verified app ID; never publish that ID.

Only after reads work and a non-empty allowlist is configured, test one harmless
write, observe it and restore the state. Do not test locks, alarms, gates,
servers, network equipment or broad scripts.
Back up configuration/database and retain a rollback image before replacing
a working deployment. Remove only verified unused project artifacts afterward.

Report observed successes and actual limitations. Mark unavailable checks
NOT VERIFIED. Do not include secrets, personal URLs or private logs in a public
report, repository, screenshot or release.
```

See [complete setup](plugin-migration.md), [Docker](docker.md), [NAS](nas-docker.md), [security](security.md) and [migration](https://github.com/aferende/ha-chatgpt-gateway/wiki/Migrating-to-v0.7.0).
