# Docker and Docker Compose installation

## v0.7.0 plugin stack and breaking migration

New installations use MCP/Keycloak instead of a GPT Action. Separate gateway `.env` and provider `.env.keycloak` files. The legacy instructions below require `ENABLE_LEGACY_REST_API=true`; see [plugin migration](plugin-migration.md) for OAuth bootstrap.

```sh
docker compose --env-file .env --env-file .env.keycloak \
  -f docker-compose.ghcr.yml -f docker-compose.oauth.yml --profile oauth pull
docker compose --env-file .env --env-file .env.keycloak \
  -f docker-compose.ghcr.yml -f docker-compose.oauth.yml --profile oauth up -d
```

For a source build replace the GHCR file with `docker-compose.yml` and use `up -d --build`.

Source builds require Docker BuildKit/buildx, which supplies `BUILDPLATFORM` automatically. The Dockerfile compiles TypeScript on the builder's native platform and packages the JavaScript-only runtime dependencies for both amd64 and arm64. It rejects native `.node` addons rather than silently copying incompatible binaries. Adding native runtime dependencies requires revisiting this build strategy. On an older NAS without buildx, prefer the published GHCR image.

When Keycloak is already configured, the gateway can also run standalone:

```sh
docker run -d --name ha-chatgpt-gateway --restart unless-stopped \
  --env-file .env -p 127.0.0.1:8787:8787 \
  --read-only --tmpfs /tmp --security-opt no-new-privileges:true \
  ghcr.io/aferende/ha-chatgpt-gateway:v0.7.0
```

Provider/database storage remains required and persistent. Proxy HTTPS to the loopback gateway; a containerized proxy can use a private Docker network. Do not delete PostgreSQL volumes during updates.

The gateway needs Docker Engine 24+ with Docker Compose v2. The published image supports `linux/amd64` and `linux/arm64`.

Use a local `.env` file for all runtime values. It contains Home Assistant and gateway credentials, so never commit it or paste it into ChatGPT:

```bash
cp .env.example .env
chmod 600 .env
```

For the first run, keep `READ_ONLY=true`, `ALLOWED_DOMAINS=light,switch`, and use an empty `ALLOWED_ENTITIES` value only for short discovery. Before enabling writes, add a short explicit allow-list: the gateway refuses to start with `READ_ONLY=false` and an empty `ALLOWED_ENTITIES` value. See [security.md](security.md) before enabling writes.

## Option 1: Docker Compose with the GHCR image

This is the recommended production method. Download `docker-compose.ghcr.yml` from the release repository and save it as `docker-compose.yml` beside `.env`:

```bash
mkdir -p ha-chatgpt-gateway
cd ha-chatgpt-gateway
curl -fsSLO https://raw.githubusercontent.com/aferende/ha-chatgpt-gateway/main/docker-compose.ghcr.yml
mv docker-compose.ghcr.yml docker-compose.yml
# Create and edit .env as described above.
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 ha-chatgpt-gateway
```

The service is named `ha-chatgpt-gateway` and is reachable on the Docker host at `http://localhost:8787` by default:

```bash
curl --fail http://localhost:8787/health
```

## Option 2: Docker Compose from a source checkout

Use this while developing or when you intentionally need a local image build:

```bash
git clone https://github.com/aferende/ha-chatgpt-gateway.git
cd ha-chatgpt-gateway
cp .env.example .env
# Edit .env, then:
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 ha-chatgpt-gateway
```

To stop only this project:

```bash
docker compose down
```

`docker compose down` removes this project's container and network but leaves `.env` untouched. It does not remove unrelated Docker resources.

## Option 3: Docker CLI (`docker run`)

Create `.env` in a dedicated directory, then run:

```bash
docker pull ghcr.io/aferende/ha-chatgpt-gateway:latest

docker run -d \
  --name ha-chatgpt-gateway \
  --restart unless-stopped \
  --env-file .env \
  -p 8787:8787 \
  --security-opt no-new-privileges:true \
  --read-only \
  --tmpfs /tmp \
  ghcr.io/aferende/ha-chatgpt-gateway:latest

docker ps --filter name=ha-chatgpt-gateway
docker logs --tail=100 ha-chatgpt-gateway
curl --fail http://localhost:8787/health
```

Do not publish port `8787` directly to the Internet. Place it behind the HTTPS reverse proxy described in [reverse-proxy.md](reverse-proxy.md). If the proxy runs on the same host, it can target `127.0.0.1:8787`; otherwise restrict firewall access to the proxy host or trusted LAN. Configure `TRUSTED_PROXIES` only after verifying the peer address the container receives from that proxy.

## Updating

For a Compose deployment:

```bash
docker compose pull
docker compose up -d
docker compose ps
```

For a `docker run` deployment:

```bash
docker pull ghcr.io/aferende/ha-chatgpt-gateway:latest
docker stop ha-chatgpt-gateway
docker rm ha-chatgpt-gateway
# Run the same docker run command again; the local .env file is preserved.
```

Inspect the output of `docker image ls` before removing old images. On a shared host, do not run a broad image prune without confirming it cannot affect other projects.

## Troubleshooting

| Symptom                            | Check                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Container exits immediately        | Run `docker logs ha-chatgpt-gateway`; required environment values may be missing or invalid.           |
| Health endpoint fails              | Confirm the container is running and that port `8787` is not occupied.                                 |
| Home Assistant reports unavailable | Use a Home Assistant URL reachable from inside the Docker host/container; check `/api/v1/diagnostics`. |
| Public Action cannot import        | Verify public HTTPS, certificate, `PUBLIC_BASE_URL`, and the standard port-443 reverse-proxy route.    |
