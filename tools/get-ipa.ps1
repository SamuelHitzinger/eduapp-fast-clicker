# Downloads the iPhone app from the latest successful GitHub build to the Desktop (FastClicker.ipa),
# ready to drag into Sideloadly.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$run = gh run list --workflow ios.yml --status success --limit 1 --json databaseId,displayTitle,createdAt | ConvertFrom-Json | Select-Object -First 1
if (-not $run) { throw 'No successful iPhone build found on GitHub.' }
$out = Join-Path $PWD 'app-download'
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
gh run download $run.databaseId -D $out | Out-Null
$ipa = Join-Path $out 'FastClicker-ipa\FastClicker.ipa'
$dest = Join-Path ([Environment]::GetFolderPath('Desktop')) 'FastClicker.ipa'
Copy-Item $ipa $dest -Force
Write-Host "Build: $($run.displayTitle) ($($run.createdAt))"
Write-Host "Saved: $dest  -> drag it into Sideloadly and click Start."
