# Deploying the Gateway

The standard plugin stack contains gateway, Keycloak and PostgreSQL. Use the same Compose project and both compose files so dependencies are managed together.

```sh
docker compose --env-file .env --env-file .env.keycloak \
  -f docker-compose.ghcr.yml -f docker-compose.oauth.yml --profile oauth pull
docker compose --env-file .env --env-file .env.keycloak \
  -f docker-compose.ghcr.yml -f docker-compose.oauth.yml --profile oauth up -d
```

For a source build replace the GHCR file with `docker-compose.yml` and use `up -d --build`.
Pin an official release image/digest in production. Keep Keycloak/PostgreSQL persistent and exclude unreviewed automatic image updates.

## NAS and HTTPS

Identify the existing NAS Docker directory and architecture. Do not alter unrelated stacks.
Use a trusted certificate and existing reverse proxy; never expose Home Assistant 8123 or gateway HTTP 8787 directly to Internet.
Where router forwarding is necessary, forward TCP 443 to the HTTPS proxy. With double NAT configure both routers; CGNAT requires an alternative reachability solution, not arbitrary extra port exposure.
Keycloak binds to loopback. Proxy its application realm/login resources, not its admin/master endpoints.
Verify the Docker-visible proxy peer before configuring trust.

[Docker run and Compose](https://github.com/aferende/ha-chatgpt-gateway/blob/main/docs/docker.md) · [NAS example](https://github.com/aferende/ha-chatgpt-gateway/blob/main/docs/nas-docker.md) · [Reverse proxy](https://github.com/aferende/ha-chatgpt-gateway/blob/main/docs/reverse-proxy.md)
