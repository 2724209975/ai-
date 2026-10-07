package cn.replyassistant

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.enableEdgeToEdge
import cn.replyassistant.platform.OverlayService
import cn.replyassistant.ui.AssistantApp
import cn.replyassistant.ui.AssistantTheme

class MainActivity : ComponentActivity() {
    private val controller get() = (application as AssistantApplication).controller
    private var startAfterOverlayPermission = false
    private var pickerArchiveId: String? = null
    private val picker = registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(8)) { uris ->
        if (uris.isNotEmpty()) {
            val target = pickerArchiveId
            if (target != null && controller.state.value.archives.any { it.id == target }) {
                controller.openAdvisor(target)
                controller.importImages(uris,forConsultation = true)
            } else controller.importImages(uris)
        }
        pickerArchiveId = null
    }
    private val permission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        controller.notice(if (granted) "运行通知已允许" else "通知未允许，仍可导入截图；服务提示可能仅在系统任务管理中显示")
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pickerArchiveId = savedInstanceState?.getString("consultPickerArchive")
        enableEdgeToEdge()
        if (savedInstanceState == null) receiveShare(intent)
        setContent { AssistantTheme { AssistantApp(controller,
            onPick = { pickerArchiveId = controller.state.value.advisorArchiveId; picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
            onPermission = { action ->
                when (action) {
                    "overlay" -> startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
                    "notification" -> startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                    "accessibility" -> startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                    "post" -> permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                    "start" -> if (Settings.canDrawOverlays(this)) startForegroundService(Intent(this, OverlayService::class.java))
                        else {
                            startAfterOverlayPermission = true
                            controller.notice("允许悬浮窗后返回，助手会开启。填写还需在设置中允许无障碍。")
                            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
                        }
                    "stop" -> stopService(Intent(this, OverlayService::class.java))
                }
            }) } }
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("consultPickerArchive",pickerArchiveId)
        super.onSaveInstanceState(outState)
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); receiveShare(intent) }
    override fun onResume() {
        super.onResume(); OverlayService.hostVisibility(true)
        if (startAfterOverlayPermission && Settings.canDrawOverlays(this)) {
            startAfterOverlayPermission = false
            startForegroundService(Intent(this, OverlayService::class.java))
        }
    }
    override fun onPause() { OverlayService.hostVisibility(false); super.onPause() }
    private fun receiveShare(intent: Intent?) {
        if (intent?.type?.startsWith("image/") != true) return
        val uris: List<Uri> = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java))
            Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            else -> emptyList()
        }
        if (uris.isNotEmpty()) controller.importImages(uris)
    }
}
