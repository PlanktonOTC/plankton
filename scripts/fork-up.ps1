# One command that (re)builds the whole local test system and leaves it ready to trade on:
#   .\scripts\fork-up.ps1                                  chain + backend, no database (orders, history and the keeper are off)
#   .\scripts\fork-up.ps1 -DatabaseUrl postgresql://...    the same with a THROWAWAY database (its tables are emptied)
#
# Why it exists: the local chain copies its state from Robinhood's public RPC as it needs it, and that RPC keeps only a limited
# window of history. If actions start failing with "historical state ... is not available", the copy has gone stale. Run this
# again whenever that happens. Then start the site with:  bun run dev:web   and open http://127.0.0.1:5173/trade
param([string]$DatabaseUrl = '')

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
if ($DatabaseUrl) { $env:DATABASE_URL = $DatabaseUrl }

'1/5 stopping anything left over'
& "$PSScriptRoot\fork-stack.ps1" -Stop | Out-Null
& "$PSScriptRoot\fork-setup.ps1" -Stop | Out-Null

'2/5 building the test chain (deploys the contracts, registers the markets)'
& "$PSScriptRoot\fork-setup.ps1"
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'fork-setup failed: run it by hand to see why' }

'3/5 starting the backend'
& "$PSScriptRoot\fork-stack.ps1" | Out-Null

'4/5 waiting for the first market to be confirmed (a market priced from Robinhood alone needs 20 checks, about a minute)'
# The funding step trades the FIRST configured market, so wait for that one. Confidence 9999 means "still warming up".
$first = (Get-Content (Join-Path $root 'config\markets.json') -Raw | ConvertFrom-Json).markets[0].symbol
$ready = $false
for ($i = 0; $i -lt 100 -and -not $ready; $i++) {
  Start-Sleep -Seconds 3
  try { $m = Invoke-RestMethod http://127.0.0.1:8788/marks -TimeoutSec 5; $ready = [bool]($m | Where-Object { $_.symbol -eq $first -and $null -ne $_.confidenceBps -and $_.confidenceBps -lt 9999 }) } catch { }
}
if (-not $ready) { throw "$first was not confirmed in time: check the logs in %TEMP%\plankton_fork_logs" }

'5/5 funding the Counter and checking the whole backend end to end'
# Native-command errors must not abort the script before bun's own message is shown.
$ErrorActionPreference = 'Continue'
& bun run scripts/e2e-fork.ts 2>&1 | ForEach-Object { "$_" }
if ($LASTEXITCODE -ne 0) { throw 'the end-to-end check failed (see the message above)' }

''
'READY. Start the site with:  bun run dev:web   then open http://127.0.0.1:5173/trade'
'This chain lasts about an hour; run this script again after that.'
