package cn.replyassistant.platform

import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.graphics.Rect
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
import cn.replyassistant.MainActivity
import kotlin.math.abs

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
    private var panelHeightFraction = .52f
    override fun onCreate() {
        super.onCreate()
        savedState.performAttach(); savedState.performRestore(null)
        instance = WeakReference(this); windowManager = getSystemService(WindowManager::class.java)
        if (!Settings.canDrawOverlays(this)) { stopSelf(); return }
        startForeground(101, ServiceNotifications.build(this, "悬浮助手已开启，点按钮打开回复面板"), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
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
        val positions = getSharedPreferences("overlay_position", MODE_PRIVATE)
        addView(button, WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, false, Gravity.END or Gravity.CENTER_VERTICAL)
        fun bounds(): Pair<Int, Int> {
            val metrics = windowManager.currentWindowMetrics
            val insets = metrics.windowInsets.getInsets(WindowInsets.Type.systemBars())
            return (metrics.bounds.width() - insets.left - insets.right - button.width).coerceAtLeast(0) to
                (metrics.bounds.height() - insets.top - insets.bottom - button.height).coerceAtLeast(0)
        }
        if (positions.contains("y")) button.post {
            if (view === button) {
                val params = button.layoutParams as WindowManager.LayoutParams
                val (maxX, maxY) = bounds()
                params.gravity = Gravity.TOP or Gravity.LEFT
                params.x = if (positions.getBoolean("right", true)) maxX else 0
                params.y = (maxY * positions.getFloat("y", .5f).coerceIn(0f,1f)).toInt()
                windowManager.updateViewLayout(button, params)
            }
        }
        var downX = 0f; var downY = 0f; var startX = 0; var startY = 0; var dragging = false
        val slop = ViewConfiguration.get(this).scaledTouchSlop
        button.setOnTouchListener { _, event ->
            val params = button.layoutParams as WindowManager.LayoutParams
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.rawX; downY = event.rawY; dragging = false
                    val location = IntArray(2); button.getLocationOnScreen(location)
                    val insets = windowManager.currentWindowMetrics.windowInsets.getInsets(WindowInsets.Type.systemBars())
                    startX = location[0] - insets.left; startY = location[1] - insets.top
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX-downX; val dy = event.rawY-downY
                    if (abs(dx) > slop || abs(dy) > slop) dragging = true
                    if (dragging) {
                        val (maxX,maxY) = bounds()
                        params.gravity = Gravity.TOP or Gravity.LEFT
                        params.x = (startX+dx).toInt().coerceIn(0,maxX)
                        params.y = (startY+dy).toInt().coerceIn(0,maxY)
                        windowManager.updateViewLayout(button,params)
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    if (dragging) {
                        val (maxX,maxY) = bounds(); val right = params.x > maxX/2
                        params.x = if (right) maxX else 0
                        windowManager.updateViewLayout(button,params)
                        positions.edit().putBoolean("right",right).putFloat("y",if (maxY > 0) params.y.toFloat()/maxY else 0f).apply()
                    } else if (event.actionMasked == MotionEvent.ACTION_UP) button.performClick()
                }
            }
            true
        }
    }
    private fun captureScreenshot(append: Boolean) {
        if (capturing) return
        capturing = true
        removeView()
        if (!CaptureService.captureIfActive(append)) startActivity(Intent(this, CaptureActivity::class.java).putExtra("append", append).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    private fun showReplyPanel() {
        val controller = (application as AssistantApplication).controller
        panelHeightFraction = getSharedPreferences("overlay_position", MODE_PRIVATE).getFloat("panel_height", .52f)
        controller.desktopForeground()
        val panel = ComposeView(this).apply {
            setViewTreeLifecycleOwner(this@OverlayService)
            setViewTreeSavedStateRegistryOwner(this@OverlayService)
            setContent { AssistantTheme { ReplyPanel(controller, compact = true, onClose = { showBubble() }, onCapture = { captureScreenshot(false) },
                onAppendCapture = { captureScreenshot(true) }, onResize = { delta ->
                    panelHeightFraction = (panelHeightFraction + delta / windowManager.currentWindowMetrics.bounds.height()).coerceIn(.38f,.78f)
                    getSharedPreferences("overlay_position", MODE_PRIVATE).edit().putFloat("panel_height", panelHeightFraction).apply()
                    resizePanel()
                }, onHistory = { id ->
                    showBubble()
                    controller.openHistory(id)
                    startActivity(Intent(this@OverlayService, MainActivity::class.java).putExtra("history",id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
                }, onLink = { id ->
                    showBubble()
                    controller.openLink(id)
                    startActivity(Intent(this@OverlayService, MainActivity::class.java).putExtra("link",id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
                }, onAdvisor = { id ->
                    controller.openAdvisor(id)
                    startActivity(Intent(this@OverlayService, MainActivity::class.java).putExtra("advisor", id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
                }) } }
        }
        val metrics = resources.displayMetrics
        addView(panel, (metrics.widthPixels * .94).toInt(), (metrics.heightPixels * panelHeightFraction).toInt(), true, Gravity.TOP or Gravity.CENTER_HORIZONTAL)
        panel.viewTreeObserver.addOnGlobalLayoutListener { resizePanel() }
    }
    private fun resizePanel() {
        val panel = view ?: return
        if (!panelVisible) return
        val metrics = windowManager.currentWindowMetrics
        val bars = metrics.windowInsets.getInsets(WindowInsets.Type.systemBars())
        val params = panel.layoutParams as WindowManager.LayoutParams
        var available = metrics.bounds.height() - bars.top - bars.bottom - params.y
        if (panel.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true) {
            val visible = Rect()
            panel.getWindowVisibleDisplayFrame(visible)
            val location = IntArray(2)
            panel.getLocationOnScreen(location)
            available = minOf(available, visible.bottom - location[1])
        }
        val height = minOf((metrics.bounds.height() * panelHeightFraction).toInt(), available)
        if (params.height == height) return
        params.height = height
        windowManager.updateViewLayout(panel, params)
    }
    override fun onDestroy() { stopService(Intent(this, CaptureService::class.java)); removeView(); if (instance.get() === this) instance.clear(); stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy() }
}
