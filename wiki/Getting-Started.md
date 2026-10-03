# Getting Started

1. Prepare Docker Engine 24+ and Compose 2.20+, a LAN Home Assistant URL, and a trusted public HTTPS hostname.
2. Clone the repository. Copy `.env.example` to `.env` and `.env.keycloak.example` to `.env.keycloak`.
3. Put the Home Assistant token only in `.env`. Generate independent Keycloak administrator/database passwords in the provider file.
4. Keep `READ_ONLY=true`, with only a small safe set such as light/switch. Use MCP-only mode for a new plugin.
5. Start the combined gateway/Keycloak/PostgreSQL Compose stack. Never delete the database volume.
6. Configure HTTPS for the gateway and the dedicated OAuth realm, keeping admin/master/database ports local.
7. Bootstrap Keycloak, using the exact ChatGPT callback and an account you control.
8. [Connect the plugin](Configuring-the-ChatGPT-Plugin), test read operations and install the supplied skill.
9. Select a short explicit entity allowlist before changing `READ_ONLY=false`. Test one harmless command and restore the state.

Self-hosting concerns the gateway/provider, not the ChatGPT model. Review the data exposed by entities/history before connecting.
[Complete installation commands](https://github.com/aferende/ha-chatgpt-gateway/blob/main/docs/plugin-migration.md)
