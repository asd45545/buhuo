[CmdletBinding()]
param(
  [string]$Repo = "asd45545/buhuo",
  [string]$Workflow = "ldxp-stock-monitor.yml",
  [string]$Ref = "main",
  [int]$TimeoutSeconds = 240,
  [int]$PollSeconds = 10,
  [switch]$NoWait
)

$ErrorActionPreference = "Stop"

function Get-GitHubToken {
  if ($env:GITHUB_TOKEN) {
    return $env:GITHUB_TOKEN
  }

  $credentialInput = "protocol=https`nhost=github.com`n`n"
  $credential = $credentialInput | git credential fill
  $tokenLine = $credential | Where-Object { $_ -like "password=*" } | Select-Object -First 1
  if (-not $tokenLine) {
    throw "No GitHub token found. Sign in to GitHub in the browser or Git Credential Manager first."
  }

  return $tokenLine.Substring(9)
}

function New-GitHubHeaders([string]$Token) {
  return @{
    Authorization = "Bearer $Token"
    Accept = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent" = "Codex-LDXP-Automation"
  }
}

$token = Get-GitHubToken
$headers = New-GitHubHeaders -Token $token
$baseUri = "https://api.github.com/repos/$Repo/actions/workflows/$Workflow"
$startedAt = (Get-Date).ToUniversalTime().AddSeconds(-5)

$body = @{ ref = $Ref } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri "$baseUri/dispatches" -Headers $headers -ContentType "application/json" -Body $body | Out-Null

Write-Output "WORKFLOW_DISPATCHED repo=$Repo workflow=$Workflow ref=$Ref started_at=$($startedAt.ToString("o"))"

if ($NoWait) {
  exit 0
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$run = $null
$announcedRun = $false

while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds $PollSeconds

  $runs = Invoke-RestMethod -Uri "$baseUri/runs?event=workflow_dispatch&per_page=20" -Headers $headers
  $run = $runs.workflow_runs |
    Where-Object {
      $_.head_branch -eq $Ref -and ([datetime]$_.created_at).ToUniversalTime() -ge $startedAt
    } |
    Sort-Object -Property created_at -Descending |
    Select-Object -First 1

  if (-not $run) {
    continue
  }

  if (-not $announcedRun) {
    Write-Output "WORKFLOW_RUN_FOUND run_id=$($run.id) status=$($run.status) url=$($run.html_url)"
    $announcedRun = $true
  }

  if ($run.status -eq "completed") {
    if ($run.conclusion -eq "success") {
      Write-Output "WORKFLOW_SUCCESS run_id=$($run.id) url=$($run.html_url)"
      exit 0
    }

    Write-Output "WORKFLOW_FAILED run_id=$($run.id) conclusion=$($run.conclusion) url=$($run.html_url)"
    exit 1
  }
}

if ($run) {
  Write-Output "WORKFLOW_TIMEOUT run_id=$($run.id) status=$($run.status) url=$($run.html_url)"
} else {
  Write-Output "WORKFLOW_TIMEOUT no_run_found repo=$Repo workflow=$Workflow ref=$Ref"
}

exit 1
