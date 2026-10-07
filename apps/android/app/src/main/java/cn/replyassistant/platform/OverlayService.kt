package cn.replyassistant.platform

import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.os.Build
import android.provider.Settings
import android.view.*
import android.widget.TextView
import androidx.compose.ui.platform.ComposeView
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import cn.replyassistant.AssistantApplication
import cn.replyassistant.ui.AssistantTheme
import cn.replyassistant.ui.ReplyPanel
import java.lang.ref.WeakReference

class OverlayService : LifecycleService(), SavedStateRegistryOwner {
    companion object {
        private var instance = WeakReference<OverlayService>(null)
        private var hostVisible = false
        fun hostVisibility(visible: Boolean) {
            hostVisible = visible
            instance.get()?.let { if (visible) it.removeView() else if (!it.capturing) it.showBubble() }
        }
        fun showPanel() { instance.get()?.let { it.capturing = false; if (!hostVisible) it.showReplyPanel() } }
        fun hidePanel() { instance.get()?.showBubble() }
        fun running() = instance.get() != null
    }
    private val savedState = SavedStateRegistryController.create(this)
    override val savedStateRegistry: SavedStateRegistry get() = savedState.savedStateRegistry
    private lateinit var windowManager: WindowManager
    private var view: View? = null
    private var capturing = false
    private var panelVisible = false
    override fun onCreate() {
        super.onCreate()
        savedState.performAttach(); savedState.performRestore(null)
        instance = WeakReference(this); windowManager = getSystemService(WindowManager::class.java)
        if (!Settings.canDrawOverlays(this)) { stopSelf(); return }
        startForeground(101, ServiceNotifications.build(this, "悬浮助手已开启，点按钮截屏"), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        if (!hostVisible) showBubble()
        lifecycleScope.launch {
            (application as AssistantApplication).controller.state.collect { state ->
                view?.let { current ->
                    val params = current.layoutParams as? WindowManager.LayoutParams ?: return@let
                    val opacity = (if (panelVisible) state.settings.panelOpacity else state.settings.bubbleOpacity).coerceIn(.2f,1f)
                    if (params.alpha != opacity) { params.alpha = opacity; runCatching { windowManager.updateViewLayout(current,params) } }
                }
            }
        }
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int { super.onStartCommand(intent, flags, startId); return START_NOT_STICKY }
    private fun removeView() { view?.let { runCatching { windowManager.removeView(it) } }; view = null }
    private fun addView(next: View, width: Int, height: Int, focusable: Boolean, gravity: Int) {
        removeView()
        if (!Settings.canDrawOverlays(this)) { stopSelf(); return }
        val params = WindowManager.LayoutParams(width, height, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            if (focusable) WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL else WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT).apply {
                this.gravity = gravity
                x = if (focusable) 0 else 12
                y = if (focusable) (8 * resources.displayMetrics.density).toInt() else 80
                softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
            }
        panelVisible = focusable
        val settings = (application as AssistantApplication).controller.state.value.settings
        params.alpha = (if (focusable) settings.panelOpacity else settings.bubbleOpacity).coerceIn(.2f,1f)
        view = next
        runCatching { windowManager.addView(next, params) }.onFailure {
            (application as AssistantApplication).controller.reportError("悬浮窗不可用，请在 App 中处理截图"); stopSelf()
        }
    }
    private fun showBubble() {
        if (hostVisible || capturing) return
        val button = TextView(this).apply {
            text = "回复"; textSize = 16f; setTextColor(android.graphics.Color.WHITE)
            background = android.graphics.drawable.GradientDrawable().apply { setColor(android.graphics.Color.rgb(36, 122, 104)); cornerRadius = 22 * resources.displayMetrics.density }
            setPadding(20, 18, 20, 18)
            minWidth = (56 * resources.displayMetrics.density).toInt(); minHeight = minWidth; gravity = Gravity.CENTER
            contentDescription = "打开回复面板"
            setOnClickListener {
                ChatAccessibilityService.rememberTarget()
                showReplyPanel()
            }
            setOnLongClickListener { ChatAccessibilityService.rememberTarget(); showReplyPanel(); true }
        }
        addView(button, WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, false, Gravity.END or Gravity.CENTER_VERTICAL)
    }
    private fun captureScreenshot() {
        if (capturing) return
        capturing = true
        removeView()
        if (!CaptureService.captureIfActive()) startActivity(Intent(this, CaptureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    private fun showReplyPanel() {
        val controller = (application as AssistantApplication).controller
        val panel = ComposeView(this).apply {
            setViewTreeLifecycleOwner(this@OverlayService)
            setViewTreeSavedStateRegistryOwner(this@OverlayService)
            setContent { AssistantTheme { ReplyPanel(controller, compact = true, onClose = { showBubble() }, onCapture = { captureScreenshot() }) } }
        }
        val metrics = resources.displayMetrics
        addView(panel, (metrics.widthPixels * .94).toInt(), (metrics.heightPixels * .48).toInt(), true, Gravity.TOP or Gravity.CENTER_HORIZONTAL)
    }
    override fun onDestroy() { stopService(Intent(this, CaptureService::class.java)); removeView(); if (instance.get() === this) instance.clear(); stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy() }
}
