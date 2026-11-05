param([string]$PublicOrigin = 'http://127.0.0.1:4317', [string]$Images = 'C:\Users\Administrator\Desktop\COAs_西林瓶图片_按品名剂量', [string]$Store = '')
$nodePath = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$studioArgs = @((Join-Path $PSScriptRoot 'studio.mjs'), "--images=$Images", "--public-origin=$PublicOrigin")
if ($Store) { $studioArgs += "--store=$Store" }
& $nodePath @studioArgs
