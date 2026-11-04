# Builds a fresh local test chain: anvil fork, funded test accounts, deployed contracts, applied markets.
# Then run .\scripts\fork-stack.ps1 to start the services, and `bun run scripts/e2e-fork.ts` to exercise them.
#
#   .\scripts\fork-setup.ps1          set everything up
#   .\scripts\fork-setup.ps1 -Stop    stop anvil
#
# If DATABASE_URL is set (here or in .env) the working tables are emptied, because a new fork is a new chain.
# Only point it at a throwaway database. Uses anvil's public test keys: worthless anywhere but this fork.
param([switch]$Stop)

$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
$rpc = 'http://127.0.0.1:8545'
$pidFile = Join-Path $env:TEMP 'anvil.pid'

if ($Stop) {
  if (Test-Path $pidFile) { Get-Content $pidFile | ForEach-Object { Stop-Process -Id ([int]$_) -Force -ErrorAction SilentlyContinue }; Remove-Item $pidFile }
  Get-Process anvil -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  'anvil stopped'
  return
}

# --- 1. the fork (the Robinhood RPC lookup sometimes fails once on this machine: retry)
$ok = $false
for ($i = 1; $i -le 6 -and -not $ok; $i++) {
  $p = Start-Process anvil -ArgumentList '--fork-url', 'https://rpc.mainnet.chain.robinhood.com', '--port', '8545', '--accounts', '10', '--hardfork', 'cancun' -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $env:TEMP 'anvil.log') -RedirectStandardError (Join-Path $env:TEMP 'anvil.err')
  Start-Sleep -Seconds 8
  if (& cast chain-id --rpc-url $rpc 2>$null) { $ok = $true; $p.Id | Out-File $pidFile } else { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 4 }
}
if (-not $ok) { throw 'could not start the fork (network?)' }
& cast rpc evm_setIntervalMining 1 --rpc-url $rpc | Out-Null   # a block per second, like the real chain
'fork running, chain id ' + (& cast chain-id --rpc-url $rpc)

# --- 2. test USDG: borrow from Morpho, which holds tens of millions on the real chain
$usdg = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
$holder = '0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010'
& cast rpc anvil_impersonateAccount $holder --rpc-url $rpc | Out-Null
& cast rpc anvil_setBalance $holder 0x56BC75E2D63100000 --rpc-url $rpc | Out-Null
foreach ($a in '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', '0x976EA74026E726554dB657fA54763abd0C3a0aa9', '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955') {
  & cast send $usdg 'transfer(address,uint256)' $a 200000000000 --from $holder --unlocked --rpc-url $rpc 2>&1 | Out-Null
}
'funded 3 accounts with 200,000 USDG each'

# anvil's public test keys are known to everyone, and on the real chain bots have given them EIP-7702 smart-account code. The
# exchange treats an account with code as a smart wallet and asks that code to approve order signatures, so a plain test key
# would be refused (BadSigner). Clearing the code on this PRIVATE fork makes them ordinary wallets again, like a real user's.
foreach ($a in '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', '0x90F79bf6EB2c4f870365E785982E1f101E93b906', '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc', '0x976EA74026E726554dB657fA54763abd0C3a0aa9', '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955', '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f', '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720') {
  & cast rpc anvil_setCode $a 0x --rpc-url $rpc | Out-Null
}
'cleared smart-account code from the 10 test accounts'

# --- 3. deploy and register markets
$deployerKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
Push-Location (Join-Path $root 'contracts')
$env:OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
$env:GUARDIAN = $env:OWNER
$env:TREASURY = '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f'
$env:MARK_SIGNERS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8,0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
$env:QUOTE_SIGNERS = '0x90F79bf6EB2c4f870365E785982E1f101E93b906'
$r = & forge script script/Deploy.s.sol --rpc-url $rpc --broadcast --private-key $deployerKey 2>&1 | Out-String
if ($r -notmatch 'ONCHAIN EXECUTION COMPLETE') { Pop-Location; throw "deploy failed:`n$r" }
'contracts deployed'
foreach ($sig in @('schedule()')) {
  $r = & forge script script/ConfigureMarkets.s.sol --sig $sig --rpc-url $rpc --broadcast --private-key $deployerKey 2>&1 | Out-String
  if ($r -notmatch 'ONCHAIN EXECUTION COMPLETE') { Pop-Location; throw "$sig failed:`n$r" }
}
Pop-Location
'markets registered'

# --- 4. empty the throwaway database
$dbLine = if (Test-Path (Join-Path $root '.env')) { Select-String -Path (Join-Path $root '.env') -Pattern '^\s*DATABASE_URL=' | Select-Object -First 1 }
if ($env:DATABASE_URL -or $dbLine) {
  $env:FORK_DB_RESET = 'yes'
  Push-Location $root
  & bun run scripts/db-reset.ts 2>&1 | Where-Object { $_ -match 'emptied|refusing|Error|error' }
  Pop-Location
  Remove-Item Env:FORK_DB_RESET
}
'setup complete. Next: .\scripts\fork-stack.ps1'
