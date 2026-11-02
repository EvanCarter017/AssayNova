$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
node server.mjs --watch @args
