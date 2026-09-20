# Public HTTPS, reverse proxy, and router forwarding

A ChatGPT GPT Action must reach the gateway through a public HTTPS origin. Terminate TLS at a reverse proxy and forward only to the local gateway port. Do not publish the gateway's plain HTTP Docker port or Home Assistant itself.

```text
Internet -> HTTPS reverse proxy :443 -> HA ChatGPT Gateway :8787 -> LAN -> Home Assistant :8123
```

Use a dedicated subdomain where possible, for example `ha-gateway.example.com`. Configure `PUBLIC_BASE_URL=https://ha-gateway.example.com` and restart the gateway. ChatGPT requires the OpenAPI server URL to match the imported HTTPS origin, so use standard HTTPS port `443` and no port suffix.

## Reverse-proxy target

Create one virtual host that accepts:

```text
https://ha-gateway.example.com:443
```

and forwards it to:

```text
http://127.0.0.1:8787
```

or to the Docker host's LAN address and mapped port when the proxy runs on another machine. Preserve the `Authorization` header, disable caching for API responses, and do not reuse or overwrite an unrelated proxy rule. Assign a valid certificate to the public hostname.

This works with Synology Reverse Proxy, Nginx, Nginx Proxy Manager, Caddy, Traefik, or an equivalent secure ingress. The exact UI differs, but the source/destination rule is the same.

## Trusted proxy configuration

The gateway's failed-auth, authenticated, and service rate limits use Fastify's `request.ip` (authenticated scopes also include credential ID). With no trusted proxy configured, that address is the TCP socket peer and forwarding headers are ignored. This is secure for direct access, but a reverse proxy then makes its own address shared by clients within each applicable scope.

```text
Internet -> trusted reverse proxy -> Fastify trustProxy -> request.ip = real client -> per-client rate limit
```

Set `TRUSTED_PROXIES` only to reverse-proxy peers that actually connect to the container. It accepts a comma-separated list of IPv4 addresses, IPv6 addresses, or CIDRs:

```env
# Default: trust nobody; forwarded headers are not authoritative.
TRUSTED_PROXIES=

# Same-host proxy only when the container really sees this peer.
TRUSTED_PROXIES=127.0.0.1

# Explicit proxy peers or a verified narrow network range.
TRUSTED_PROXIES=127.0.0.1,192.0.2.50,2001:db8::50,192.0.2.0/28
```

Do **not** use `trustProxy: true`, `0.0.0.0/0`, `::/0`, or a broad private subnet merely for convenience. Direct clients must never be able to choose their rate-limit identity by sending `X-Forwarded-For`, `Forwarded`, or `X-Real-IP`.

### Synology Reverse Proxy on the same NAS

For a Synology reverse-proxy rule targeting the same host, `TRUSTED_PROXIES=127.0.0.1` is correct only if the gateway container really sees `127.0.0.1` as the peer. Docker bridge networking commonly presents the host bridge address instead.

Before enabling trust, make one harmless request through the proxy, then inspect only this container's request log:

```bash
docker compose logs --tail=50 ha-chatgpt-gateway
```

Use the reported `remoteAddress` as the exact trusted IP. If it is a Docker bridge address and can change, inspect the gateway project's Docker network with `docker network inspect`; use only the smallest stable CIDR that contains the proxy peer. Do not trust an entire LAN or Docker address range without verifying that every possible sender is an intended proxy. Restart only this Compose project after changing `.env`.

The reverse proxy must set or preserve the actual client `X-Forwarded-For` chain. With a configured trusted peer, Fastify resolves that chain conservatively; with an untrusted peer, it ignores it.

### Synology Reverse Proxy example

In **Control Panel → Login Portal → Advanced → Reverse Proxy**, add a new rule:

| Setting              | Value                    |
| -------------------- | ------------------------ |
| Source protocol      | HTTPS                    |
| Source hostname      | `ha-gateway.example.com` |
| Source port          | `443`                    |
| Destination protocol | HTTP                     |
| Destination hostname | `127.0.0.1`              |
| Destination port     | `8787`                   |

In **Control Panel → Security → Certificate**, assign a valid certificate for `ha-gateway.example.com`. Do not expose Home Assistant port `8123` merely to support this gateway.

## Router port-forwarding scenarios

Port forwarding is necessary **only** when the public HTTPS reverse proxy is hosted on the NAS/Docker host and the router is the Internet edge. It is not needed when using a secure outbound tunnel or a managed reverse proxy that does not require inbound connections.

### Scenario A: public IP, NAS hosts the reverse proxy

Give the NAS a fixed DHCP lease or static LAN address, then create exactly one router rule:

| Router field        | Example value  |
| ------------------- | -------------- |
| Protocol            | TCP            |
| WAN / external port | `443`          |
| LAN destination     | `192.168.1.50` |
| LAN / internal port | `443`          |

Forward the **reverse proxy's HTTPS listener**, not Docker port `8787`. Never forward `8123` for this integration. Remove obsolete experimental gateway rules, such as a prior `5153 → 5153` rule, once the port-443 setup is verified.

If another service already occupies port 443 on the NAS, add a hostname-based route to its existing reverse proxy instead of creating a second listener. If the router cannot forward 443 because the ISP blocks it, prefer an outbound tunnel or a reverse-proxy service that supports standard HTTPS rather than importing a non-standard port into the GPT Action.

### Scenario B: CGNAT or no public IPv4

Router forwarding will not work behind CGNAT. Typical signs are a router WAN address in a private/reserved range or a WAN address that differs from the public IP shown by an external service. Use an outbound HTTPS tunnel, a VPS reverse proxy, or ask the ISP for a public IP. Keep the same public-origin and TLS requirements.

### Scenario C: secure outbound tunnel

With a tunnel such as Cloudflare Tunnel or another authenticated outbound tunnel, no inbound router rule is required. Configure the tunnel's public hostname to reach the local reverse proxy or gateway, retain HTTPS at the public hostname, and keep `PUBLIC_BASE_URL` equal to that public origin. Apply the tunnel provider's access controls in addition to the gateway key.

## Verification

From mobile data or another external network, not only home Wi-Fi:

```bash
curl --fail --silent --show-error https://ha-gateway.example.com/health
curl --fail --silent --show-error https://ha-gateway.example.com/openapi.json
```

Confirm that the certificate is trusted, `/openapi.json` is valid JSON, and it advertises the same `https://ha-gateway.example.com` origin. Do not test a service call with a lock, alarm, door, gate, or other safety-critical entity.
