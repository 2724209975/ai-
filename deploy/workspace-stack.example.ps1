# Load your existing private owner/database/platform configuration before this template.
# Both platform accounts need distinct internal IDs and their own ingress credentials.
$env:LOCAL_STACK_PLATFORMS = 'qq,wechat'
$env:LOCAL_QQ_BRIDGE_PORT = '19099'
$env:LOCAL_WECHAT_BRIDGE_PORT = '19100'
$env:START_PAUSED = '0'
# Keep the existing QQ_ENABLE_OUTBOUND / WECHAT_ENABLE_OUTBOUND authorization switches.
# Point NapCat's callback to the QQ port and wxhelper's callback to the WeChat port.
# npm run build:web
# npm run serve:local
