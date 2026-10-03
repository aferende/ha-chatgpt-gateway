param([switch]$Build)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
foreach ($file in @('.env', '.env.keycloak')) {
    if (-not (Test-Path -LiteralPath $file)) {
        Copy-Item -LiteralPath "$file.example" -Destination $file
        Write-Host "Created $file. Edit the private settings before running this script again."
    }
}
$gatewayText = Get-Content -Raw -LiteralPath '.env'
$providerText = Get-Content -Raw -LiteralPath '.env.keycloak'
foreach ($field in @('HOME_ASSISTANT_TOKEN', 'MCP_PUBLIC_URL', 'MCP_OAUTH_ISSUER', 'MCP_OAUTH_JWKS_URL')) {
    if ($gatewayText -notmatch "(?m)^$field=.+$") { throw "Missing gateway setting: $field" }
}
foreach ($field in @('OAUTH_ADMIN_PASSWORD', 'OAUTH_DB_PASSWORD', 'OAUTH_PUBLIC_URL')) {
    if ($providerText -notmatch "(?m)^$field=.+$") { throw "Missing provider setting: $field" }
}
if ($gatewayText -match '(?m)^OAUTH_(ADMIN_PASSWORD|DB_PASSWORD)=') {
    throw 'Keep provider passwords out of the gateway environment.'
}
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
foreach ($file in @('.env', '.env.keycloak')) {
    & icacls $file /inheritance:r /grant:r "${identity}:(F)" '*S-1-5-18:(F)' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to restrict environment file permissions.' }
}
$gatewayFile = if ($Build) { 'docker-compose.yml' } else { 'docker-compose.ghcr.yml' }
$compose = @('compose', '--env-file', '.env', '--env-file', '.env.keycloak', '-f', $gatewayFile, '-f', 'docker-compose.oauth.yml', '--profile', 'oauth')
& docker @compose config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Compose validation failed.' }
if (-not $Build) {
    & docker @compose pull
    if ($LASTEXITCODE -ne 0) { throw 'Image pull failed.' }
}
if ($Build) { & docker @compose up -d --build } else { & docker @compose up -d }
if ($LASTEXITCODE -ne 0) { throw 'Stack startup failed.' }
Write-Host 'Stack started. Configure HTTPS, bootstrap Keycloak and connect ChatGPT.'
