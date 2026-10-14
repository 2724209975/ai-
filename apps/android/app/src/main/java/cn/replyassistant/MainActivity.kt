package cn.replyassistant

import androidx.lifecycle.lifecycleScope
import androidx.core.content.FileProvider
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import java.io.File
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
    private val pairingFile get() = File(cacheDir,"pairing/scan.jpg")
    private val pairingCapture=registerForActivityResult(ActivityResultContracts.TakePicture()) { success ->
        if(success) lifecycleScope.launch {
            val scanner=BarcodeScanning.getClient()
            try {
                val uri=FileProvider.getUriForFile(this@MainActivity,"$packageName.pairing",pairingFile)
                val codes=scanner.process(InputImage.fromFilePath(this@MainActivity,uri)).await()
                val code=codes.mapNotNull {it.rawValue}.singleOrNull {it.contains("fingerprint")&&it.contains("endpoint")}
                if(code!=null) controller.pairDesktop(code) else controller.reportError("未识别到配对二维码，请重新拍摄或粘贴配对内容")
            } catch(_:Exception) {controller.reportError("配对二维码读取失败，请重新拍摄或粘贴")}
            finally {scanner.close();pairingFile.delete()}
        } else pairingFile.delete()
    }
    private var startAfterOverlayPermission = false
    private val backupExport=registerForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")){uri->if(uri!=null)controller.exportBackup(uri)else controller.cancelBackup()}
    private val backupImport=registerForActivityResult(ActivityResultContracts.OpenDocument()){uri->if(uri!=null)controller.importBackup(uri)else controller.cancelBackup()}
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
        if (savedInstanceState == null) { receiveShare(intent); receiveAdvisor(intent) }
        setContent { AssistantTheme { AssistantApp(controller,
            onPick = { pickerArchiveId = controller.state.value.advisorArchiveId; picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
            onPermission = { action ->
                when (action) {
                    "backupExport"->backupExport.launch("reply-assistant-${java.time.LocalDate.now()}.rab")
                    "backupImport"->backupImport.launch(arrayOf("application/octet-stream","application/json","*/*"))
                    "pairScan" -> { pairingFile.parentFile?.mkdirs(); val uri=FileProvider.getUriForFile(this,"$packageName.pairing",pairingFile); runCatching { pairingCapture.launch(uri) }.onFailure {controller.reportError("相机不可用，请粘贴电脑配对内容")} }
                    "overlay" -> startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
                    "notification" -> startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                    "accessibility" -> startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                    "post" -> permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                    "start" -> if (Settings.canDrawOverlays(this)) startForegroundService(Intent(this, OverlayService::class.java))
                        else {
                            startAfterOverlayPermission = true
                            controller.notice("允许悬浮窗后返回，助手会开启。主动读取聊天可另行允许无障碍。")
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
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); receiveShare(intent); receiveAdvisor(intent) }
    private fun receiveAdvisor(intent: Intent?) {
        intent?.getStringExtra("link")?.let {controller.openLink(it);return}
        intent?.getStringExtra("history")?.let {id->
            if(controller.state.value.archives.any {it.id==id&&it.enabled})controller.openHistory(id)
            return
        }
        val id = intent?.getStringExtra("advisor") ?: return
        if (controller.state.value.archives.any { it.id == id && it.enabled } && !controller.state.value.busy) controller.openAdvisor(id)
    }
    override fun onResume() {
        super.onResume(); OverlayService.hostVisibility(true); controller.desktopForeground()
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
