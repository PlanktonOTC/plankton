# Starts the backend services against a LOCAL anvil fork of Robinhood Chain (http://127.0.0.1:8545).
#
#   .\scripts\fork-stack.ps1          start signers, mark service and API (plus keeper/indexer if DATABASE_URL is set)
#   .\scripts\fork-stack.ps1 -Stop    stop everything it started
#
# Prerequisites: anvil running with --fork-url, contracts deployed and markets applied (see docs/local-fork.md).
# The keys below are anvil's public test keys. They hold fake money on a private fork and are worthless anywhere else.
param([switch]$Stop)

$root = Split-Path $PSScriptRoot -Parent
$pidFile = Join-Path $env:TEMP 'plankton_fork_pids.txt'
$logDir = Join-Path $env:TEMP 'plankton_fork_logs'

if ($Stop) {
  if (Test-Path $pidFile) {
    Get-Content $pidFile | ForEach-Object { Stop-Process -Id ([int]$_) -Force -ErrorAction SilentlyContinue }
    Remove-Item $pidFile
    'stopped'
  } else { 'nothing to stop' }
  return
}

$keys = @{
  markSigner1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'  # anvil account 1
  markSigner2 = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'  # anvil account 2
  quoteSigner = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'  # anvil account 3
  publisher   = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a'  # anvil account 4
  keeper      = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'  # anvil account 5
}
$common = @{
  RPC_URLS = 'http://127.0.0.1:8545'
  SIGNER_AUTH_TOKEN = 'local-fork-token-0123456789'
  NODE_ENV = 'development'
  LOG_LEVEL = 'info'
}

New-Item -ItemType Directory -Force $logDir | Out-Null
$started = @()

function Start-Svc($name, $script, $extra) {
  $vars = @{}; $common.GetEnumerator() | ForEach-Object { $vars[$_.Key] = $_.Value }; $extra.GetEnumerator() | ForEach-Object { $vars[$_.Key] = $_.Value }
  $old = @{}
  foreach ($k in $vars.Keys) { $old[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $vars[$k]) }
  $p = Start-Process bun -ArgumentList 'run', $script -WorkingDirectory $root -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $logDir "$name.log") -RedirectStandardError (Join-Path $logDir "$name.err")
  foreach ($k in $vars.Keys) { [Environment]::SetEnvironmentVariable($k, $old[$k]) }
  $script:started += $p.Id
  "{0,-14} pid {1}" -f $name, $p.Id
}

Start-Svc 'signer-quote' 'apps/signer/src/index.ts' @{ SIGNER_ROLE = 'quote'; SIGNER_PRIVATE_KEY = $keys.quoteSigner; SIGNER_PORT = '8790' }
Start-Svc 'signer-mark1' 'apps/signer/src/index.ts' @{ SIGNER_ROLE = 'mark'; SIGNER_PRIVATE_KEY = $keys.markSigner1; SIGNER_PORT = '8791' }
Start-Svc 'signer-mark2' 'apps/signer/src/index.ts' @{ SIGNER_ROLE = 'mark'; SIGNER_PRIVATE_KEY = $keys.markSigner2; SIGNER_PORT = '8792' }
Start-Sleep -Seconds 2
Start-Svc 'mark' 'apps/mark/src/index.ts' @{ PUBLISHER_PRIVATE_KEY = $keys.publisher; MARK_SIGNER_URLS = 'http://127.0.0.1:8791,http://127.0.0.1:8792'; MARK_PORT = '8788' }
Start-Svc 'api' 'apps/api/src/index.ts' @{ QUOTE_SIGNER_URLS = 'http://127.0.0.1:8790'; API_PORT = '8787'; MARK_SERVICE_URL = 'http://127.0.0.1:8788' }

# bun reads .env for each service by itself; this only decides whether to start the services that need a database.
$hasDb = [bool]$env:DATABASE_URL -or ((Test-Path (Join-Path $root '.env')) -and (Select-String -Path (Join-Path $root '.env') -Pattern '^\s*DATABASE_URL=.+' -Quiet))
if ($hasDb) {
  Start-Svc 'indexer' 'apps/indexer/src/index.ts' @{}
  Start-Svc 'keeper' 'apps/keeper/src/index.ts' @{ KEEPER_PRIVATE_KEY = $keys.keeper; KEEPER_PORT = '8795'; API_URL = 'http://127.0.0.1:8787' }
} else {
  'DATABASE_URL not set: indexer and keeper not started (orders, positions history and liquidations need the database).'
}

$started | Set-Content $pidFile
"logs: $logDir"
