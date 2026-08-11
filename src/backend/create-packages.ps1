# Type: PowerShell Script
# Description: Creates the SCM_API.sdp file for the backend

# read the extension version from package.json
$jsonData = Get-Content -Raw -Path "..\..\package.json" | ConvertFrom-Json
$new_version = [version]$jsonData.version
$new_version = [version]::new($new_version.Major, $new_version.Minor, $new_version.Build + 1)

# patch only the version line in package.json - never rewrite the whole file,
# because ConvertTo-Json round-trips mangle non-ASCII characters (e.g. the
# author name "Döllinger" gets double-UTF-8-encoded into mojibake)
Write-Host "Patching package.json with version $new_version ..."
$pkgContent = Get-Content -Raw -Path "..\..\package.json"
$pkgContent = $pkgContent -replace '("version"\s*:\s*")[^"]*(")', "`${1}$new_version`$2"
[System.IO.File]::WriteAllText((Resolve-Path "..\..\package.json").Path, $pkgContent, [System.Text.UTF8Encoding]::new($false))

# patch the version endpoint script to return the same value
Write-Host "Patching Version.srvscr with version $new_version from package.json ..."
$version_script_file = "SCM_API\Server Scripts\SCM_API\Version.srvscr"
$content = Get-Content -Path "$version_script_file"
$content = $content -replace '(sVersion := ")[^"]*(")', "`${1}$new_version`$2"
Set-Content -Path $version_script_file -Value $content

Write-Host "Generating .sdp file ..."
# create the .sdp package, if exists, overwrite the old zip file
Compress-Archive -Force -Path .\SCM_API\* -DestinationPath .\SCM_API.zip

# if exists, delete the old sdp file
if (Test-Path .\SCM_API.sdp) {
    Remove-Item .\SCM_API.sdp
}

# rename the zip file to sdp
Rename-Item .\SCM_API.zip SCM_API.sdp 
Write-Host "Done."