$root = "$env:APPDATA\Code"   # For Insiders: "$env:APPDATA\Code - Insiders"

Get-ChildItem "$root\User\workspaceStorage" -Recurse -Filter state.vscdb -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 10 FullName, LastWriteTime

Get-ChildItem "$root\User\globalStorage" -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'copilot|chat' } |
  Select-Object FullName, LastWriteTime

Get-ChildItem "$root\logs" -Directory -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 5 FullName, LastWriteTime
