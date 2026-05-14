#!/usr/bin/env pwsh
# deploy-render.ps1 — One-shot Render deploy helper (Windows PowerShell).
# Required env vars: RENDER_API_KEY, RENDER_OWNER_ID, GITHUB_REPO, MEGA_EMAIL, MEGA_PASSWORD

$ErrorActionPreference = 'Stop'
foreach ($v in 'RENDER_API_KEY','RENDER_OWNER_ID','GITHUB_REPO','MEGA_EMAIL','MEGA_PASSWORD') {
  if (-not (Get-Item Env:$v -ErrorAction SilentlyContinue)) { throw "Env var $v required" }
}

$token = $env:PERSONAL_TOKEN
if (-not $token) {
  $token = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
}
Write-Host "PERSONAL_TOKEN: $token" -ForegroundColor Yellow
Write-Host "Save this. You'll need it in the browser client." -ForegroundColor Yellow

$headers = @{ Authorization = "Bearer $($env:RENDER_API_KEY)"; 'Content-Type' = 'application/json' }
$api = 'https://api.render.com/v1'

$orchBody = @{
  type = 'web_service'
  name = 'mega-orchestrator'
  ownerId = $env:RENDER_OWNER_ID
  repo = $env:GITHUB_REPO
  branch = 'main'
  autoDeploy = 'yes'
  serviceDetails = @{
    env = 'node'
    plan = 'starter'
    region = 'oregon'
    rootDir = 'orchestrator'
    healthCheckPath = '/health'
    envSpecificDetails = @{ buildCommand = 'npm install'; startCommand = 'node index.js' }
  }
  envVars = @(
    @{ key = 'NODE_ENV'; value = 'production' }
    @{ key = 'MIN_WORKERS'; value = '2' }
    @{ key = 'BW_LIMIT_BYTES'; value = '4294967296' }
    @{ key = 'BW_WARN_BYTES'; value = '4076863488' }
    @{ key = 'MEGA_EMAIL'; value = $env:MEGA_EMAIL }
    @{ key = 'MEGA_PASSWORD'; value = $env:MEGA_PASSWORD }
    @{ key = 'PERSONAL_TOKEN'; value = $token }
    @{ key = 'RENDER_API_KEY'; value = $env:RENDER_API_KEY }
    @{ key = 'RENDER_OWNER_ID'; value = $env:RENDER_OWNER_ID }
    @{ key = 'RENDER_GITHUB_REPO'; value = $env:GITHUB_REPO }
    @{ key = 'CLIENT_ORIGIN'; value = '*' }
  )
} | ConvertTo-Json -Depth 10

Write-Host "Creating orchestrator…"
$orch = Invoke-RestMethod -Method Post -Uri "$api/services" -Headers $headers -Body $orchBody
$orchId = if ($orch.service) { $orch.service.id } else { $orch.id }
Write-Host "Orchestrator id: $orchId"

$clientBody = @{
  type = 'static_site'
  name = 'mega-privacy-client'
  ownerId = $env:RENDER_OWNER_ID
  repo = $env:GITHUB_REPO
  branch = 'main'
  autoDeploy = 'yes'
  serviceDetails = @{ rootDir = 'client'; buildCommand = ''; publishPath = '.' }
} | ConvertTo-Json -Depth 10

Write-Host "Creating client static site…"
$client = Invoke-RestMethod -Method Post -Uri "$api/services" -Headers $headers -Body $clientBody
$clientId = if ($client.service) { $client.service.id } else { $client.id }
Write-Host "Client id: $clientId"

Write-Host ""
Write-Host "Both services created. Wait for Render to build + deploy." -ForegroundColor Green
Write-Host "Then set orchestrator's ORCHESTRATOR_URL env var to its live URL and redeploy." -ForegroundColor Green
