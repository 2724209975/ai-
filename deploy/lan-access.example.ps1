# Load your existing private database/platform/owner configuration first.
# Replace this example with this PC's Wi-Fi IPv4 address (ipconfig).
$env:PUBLIC_ORIGIN = 'http://192.168.31.17:8787'
$env:ALLOW_LAN_HTTP = '1'
$env:ALLOW_NON_LOOPBACK_BIND = '1'
$env:HOST = '0.0.0.0'
$env:PORT = '8787'
$env:SECURE_COOKIES = '0'
# Use workspace-stack.example.ps1 for dual platforms, or keep a single platform.
$env:START_PAUSED = '0'
# $env:LOCAL_BRIDGE_PLATFORM = 'wechat' # or qq
# npm run build:web
# npm run serve:local
