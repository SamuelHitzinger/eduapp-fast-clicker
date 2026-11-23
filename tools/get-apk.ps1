# Downloads the Android app from the latest successful GitHub build to the Desktop (ETHClicker.apk).
# Send it to the phone (cable, e-mail, cloud drive), open it there and allow "install unknown apps" once.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$run = gh run list --workflow android.yml --branch main --status success --limit 1 --json databaseId,displayTitle,createdAt | ConvertFrom-Json | Select-Object -First 1
if (-not $run) { throw 'No successful Android build found on GitHub.' }
$out = Join-Path $PWD 'app-download'
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
gh run download $run.databaseId -n ETHClicker-apk -D $out | Out-Null
$apk = Join-Path $out 'ETHClicker.apk'
$dest = Join-Path ([Environment]::GetFolderPath('Desktop')) 'ETHClicker.apk'
Copy-Item $apk $dest -Force
Write-Host "Build: $($run.displayTitle) ($($run.createdAt))"
Write-Host "Saved: $dest  -> send it to the Android phone and open it there."
