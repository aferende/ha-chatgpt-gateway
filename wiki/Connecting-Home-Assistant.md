# Connecting Home Assistant

Create a Long-Lived Access Token in the Home Assistant profile of the account the gateway will use.
Save it only in the private gateway environment, with restricted host file permissions. Never put it in plugin configuration, OAuth fields, instructions, screenshots or source control.

The gateway requires LAN access to Home Assistant; public access to Home Assistant is not needed.
Begin in read-only mode with a small domain policy, discover entities, then build an explicit safe allowlist.
Areas/devices help identify targets, but commands use explicit validated entity IDs.

Home Assistant can represent lamps as switches. Check both domains and distinguish configuration/DND entities from actual lamps.
[Detailed guide](https://github.com/aferende/ha-chatgpt-gateway/blob/main/docs/home-assistant.md)
