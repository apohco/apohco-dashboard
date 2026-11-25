# Builds the backend once and deploys every function from ONE shared code
# package (all functions use CodeUri ./ and so have identical code).
# Since Phase 3 the regular `sam build` + `sam deploy` is slow on Windows (it
# zips ~30 identical functions one by one) and can hit the 260-character path
# limit, so this script:
#   1. builds into a short folder (C:\Projects\sb) after removing any old
#      .aws-sam folder (npm pack would copy it into the package);
#   2. zips one built function folder once (code.zip);
#   3. points every function at code.zip in a copy of the built template;
#   4. creates a change set WITHOUT executing it. Review it, then run
#      `aws cloudformation execute-change-set --change-set-name <arn>`.
param([string]$BuildDir = 'C:\Projects\sb')
$ErrorActionPreference = 'Stop'
$backend = Split-Path -Parent $PSScriptRoot

Set-Location $backend
if (Test-Path .aws-sam) { Remove-Item -Recurse -Force .aws-sam }
if (Test-Path $BuildDir) { Remove-Item -Recurse -Force $BuildDir }

sam build --build-dir $BuildDir
if ($LASTEXITCODE -ne 0) { throw 'sam build failed' }

$fn = Get-ChildItem $BuildDir -Directory | Select-Object -First 1
Push-Location $fn.FullName
& "$env:SystemRoot\System32\tar.exe" -a -c -f (Join-Path $BuildDir 'code.zip') *
Pop-Location

$template = Get-Content (Join-Path $BuildDir 'template.yaml')
$single = $template -replace '^(\s+)CodeUri: [A-Za-z]+Function\s*$', '$1CodeUri: code.zip'
Set-Content -Path (Join-Path $BuildDir 'template.single.yaml') -Value $single -Encoding utf8

sam deploy --config-file (Join-Path $backend 'samconfig.toml') --template-file (Join-Path $BuildDir 'template.single.yaml') --no-execute-changeset --no-confirm-changeset
if ($LASTEXITCODE -ne 0) { throw 'sam deploy failed' }
