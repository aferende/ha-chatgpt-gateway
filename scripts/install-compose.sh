#!/usr/bin/env sh
# Run from the repository root after editing the two private environment files.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
for file in .env .env.keycloak; do
  if [ ! -f "$file" ]; then
    cp "$file.example" "$file"
    chmod 600 "$file"
    printf 'Created %s. Edit the private settings, then run this script again.\n' "$file"
  fi
done
for field in HOME_ASSISTANT_TOKEN MCP_PUBLIC_URL MCP_OAUTH_ISSUER MCP_OAUTH_JWKS_URL; do
  if ! grep -Eq "^${field}=.+" .env; then printf 'Missing gateway setting: %s\n' "$field"; exit 1; fi
done
for field in OAUTH_ADMIN_PASSWORD OAUTH_DB_PASSWORD OAUTH_PUBLIC_URL; do
  if ! grep -Eq "^${field}=.+" .env.keycloak; then printf 'Missing provider setting: %s\n' "$field"; exit 1; fi
done
if grep -Eq '^OAUTH_(ADMIN_PASSWORD|DB_PASSWORD)=' .env; then
  printf 'Keep provider passwords in .env.keycloak, not the gateway environment.\n'; exit 1
fi
chmod 600 .env .env.keycloak
case "${1:-}" in
  --build) gateway=docker-compose.yml ;;
  '') gateway=docker-compose.ghcr.yml ;;
  *) printf 'Usage: sh scripts/install-compose.sh [--build]\n'; exit 1 ;;
esac
# Quiet validation avoids printing the interpolated secret-bearing configuration.
docker compose --env-file .env --env-file .env.keycloak -f "$gateway" -f docker-compose.oauth.yml --profile oauth config --quiet
if [ "$gateway" = docker-compose.ghcr.yml ]; then
  docker compose --env-file .env --env-file .env.keycloak -f "$gateway" -f docker-compose.oauth.yml --profile oauth pull
  docker compose --env-file .env --env-file .env.keycloak -f "$gateway" -f docker-compose.oauth.yml --profile oauth up -d
else
  docker compose --env-file .env --env-file .env.keycloak -f "$gateway" -f docker-compose.oauth.yml --profile oauth up -d --build
fi
printf 'Stack started. Configure HTTPS, run Keycloak bootstrap, then connect ChatGPT.\n'
