param([string]$PublicOrigin = 'http://127.0.0.1:4317', [string]$Images = 'C:\Users\Administrator\Desktop\COAs_西林瓶图片_按品名剂量', [string]$Store = '', [string]$AuthStore = '')
$nodePath = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$serverPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'server.mjs'
$adminArgs = @($serverPath, '--watch', '--port=4317', '--conference-reports', '--admin', "--admin-images=$Images", "--admin-public-origin=$PublicOrigin")
if ($Store) { $adminArgs += "--conference-store=$Store" }
if ($AuthStore) { $adminArgs += "--admin-auth-store=$AuthStore" }
& $nodePath @adminArgs
exit $LASTEXITCODE
