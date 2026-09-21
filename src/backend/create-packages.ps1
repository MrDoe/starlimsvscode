# Type: PowerShell Script
# Description: Creates the SCM_API.sdp file for the backend

# All package.json / Version.srvscr IO must go through .NET with an explicit UTF-8
# encoding. Get-Content/Set-Content without -Encoding use the ANSI codepage for
# BOM-less files in Windows PowerShell 5.1, and every write then double-encodes the
# non-ASCII bytes (the author name "Dollinger" with an umlaut) until package.json
# grows to hundreds of megabytes of mojibake.
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$packageJsonPath = (Resolve-Path "..\..\package.json").Path
$versionScriptPath = (Resolve-Path "SCM_API\Server Scripts\SCM_API\Version.srvscr").Path

# read the extension version from package.json
$pkgContent = [System.IO.File]::ReadAllText($packageJsonPath, $utf8NoBom)
$jsonData = $pkgContent | ConvertFrom-Json
$new_version = [version]$jsonData.version
$new_version = [version]::new($new_version.Major, $new_version.Minor, $new_version.Build + 1)

# patch the version line only - never rewrite the whole file via ConvertTo-Json
Write-Host "Patching package.json with version $new_version ..."
$pkgContent = $pkgContent -replace '("version"\s*:\s*")[^"]*(")', "`${1}$new_version`$2"

# Safety net: refuse to write a package.json that is not valid JSON or that exploded
# in size (the old encoding bug inflated the author field to hundreds of megabytes).
if ($pkgContent.Length -gt 256KB) {
	throw "Refusing to write package.json: unexpected size of $($pkgContent.Length) characters."
}
$null = $pkgContent | ConvertFrom-Json
[System.IO.File]::WriteAllText($packageJsonPath, $pkgContent, $utf8NoBom)

# patch the version endpoint script to return the same value
Write-Host "Patching Version.srvscr with version $new_version from package.json ..."
$content = [System.IO.File]::ReadAllText($versionScriptPath, $utf8NoBom)
$content = $content -replace '(sVersion := ")[^"]*(")', "`${1}$new_version`$2"
[System.IO.File]::WriteAllText($versionScriptPath, $content, $utf8NoBom)

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
