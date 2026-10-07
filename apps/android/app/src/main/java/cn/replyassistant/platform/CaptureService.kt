package cn.replyassistant.platform

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.*
import cn.replyassistant.AssistantApplication
import kotlinx.coroutines.*
import java.lang.ref.WeakReference

/** One consent / virtual display per session; only a button press persists a frame. */
class CaptureService : Service() {
    companion object {
        private var instance = WeakReference<CaptureService>(null)
        const val STOP = "cn.replyassistant.STOP_CAPTURE"
        fun active() = instance.get()?.projection != null
        fun captureIfActive(): Boolean {
            val service = instance.get() ?: return false
            if (service.projection == null) return false
            service.requestFrame()
            return true
        }
    }
    private var projection: MediaProjection? = null
    private var reader: ImageReader? = null
    private var display: VirtualDisplay? = null
    private var pending = false
    private var processing = false
    private var stopping = false
    private var idle: Job? = null
    private var timeout: Job? = null
    private val handler = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val controller get() = (application as AssistantApplication).controller
    override fun onBind(intent: Intent?) = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) { endSession(); return START_NOT_STICKY }
        if (projection != null) return START_NOT_STICKY
        val data = intent?.getParcelableExtra("data", Intent::class.java)
        if (data == null) { stopSelf(); return START_NOT_STICKY }
        startForeground(102, ServiceNotifications.build(this,
            "连续截图已就绪；仅点按钮时保存，闲置5分钟自动结束", capture = true), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        try {
            projection = getSystemService(MediaProjectionManager::class.java).getMediaProjection(intent.getIntExtra("code", 0), data)
            instance = WeakReference(this)
            projection!!.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() { endSession(if (pending) "截屏会话已结束，下次点击重新授权" else null) }
                override fun onCapturedContentResize(width: Int, height: Int) {
                    if (!stopping && width > 0 && height > 0 && (reader?.width != width || reader?.height != height)) {
                        runCatching { resize(width, height) }.onFailure { endSession("屏幕尺寸变化，请重新截屏") }
                    }
                }
            }, handler)
            val bounds = getSystemService(android.view.WindowManager::class.java).maximumWindowMetrics.bounds
            resize(bounds.width(), bounds.height())
            display = projection!!.createVirtualDisplay("reply-screenshot", bounds.width(), bounds.height(), resources.displayMetrics.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, null, null, handler)
            requestFrame()
        } catch (_: Exception) { endSession("无法截取画面，请用系统截图后分享给回复助手") }
        return START_NOT_STICKY
    }
    private fun resize(width: Int, height: Int) {
        val previous = reader
        val next = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        reader = next
        next.setOnImageAvailableListener({ source ->
            // Drain unrequested frames without copying, saving or uploading them.
            val image = runCatching { source.acquireLatestImage() }.getOrNull() ?: return@setOnImageAvailableListener
            if (!pending || stopping) { image.close(); return@setOnImageAvailableListener }
            pending = false; processing = true; timeout?.cancel()
            display?.surface = null
            var padded: Bitmap? = null
            val bitmap = try {
                val plane = image.planes[0]
                padded = Bitmap.createBitmap(image.width + (plane.rowStride - plane.pixelStride * image.width) / plane.pixelStride,
                    image.height, Bitmap.Config.ARGB_8888)
                padded.copyPixelsFromBuffer(plane.buffer)
                Bitmap.createBitmap(padded, 0, 0, image.width, image.height)
            } catch (_: Exception) {
                padded?.recycle(); processing = false; endSession("截图失败，请重试"); null
            } finally { image.close() }
            if (bitmap == null) return@setOnImageAvailableListener
            if (padded !== bitmap) padded?.recycle()
            scope.launch {
                try { controller.addCapturedPage(ImageImporter(this@CaptureService).fromBitmap(bitmap)) }
                catch (e: CancellationException) { throw e }
                catch (_: Exception) { controller.reportError("截图保存失败，请重试或分享截图") }
                finally { bitmap.recycle(); processing = false; if (!stopping) { OverlayService.showPanel(); armIdle() } }
            }
        }, handler)
        display?.resize(width, height, resources.displayMetrics.densityDpi)
        display?.surface = if (pending) next.surface else null
        previous?.setOnImageAvailableListener(null, null)
        previous?.close()
    }
    private fun requestFrame() {
        if (stopping || pending || processing || timeout?.isActive == true) return
        idle?.cancel()
        timeout = scope.launch {
            // Wait until both the overlay and consent Activity have disappeared.
            delay(700)
            try {
                reader?.acquireLatestImage()?.close()
                pending = true
                display?.surface = reader?.surface
            } catch (_: Exception) { endSession("截屏会话不可用，请重新截图"); return@launch }
            delay(12_000)
            if (pending) endSession("没有取得截图，请重试或分享截图")
        }
    }
    private fun armIdle() {
        idle?.cancel()
        idle = scope.launch { delay(5 * 60_000L); endSession() }
    }
    private fun endSession(message: String? = null) {
        if (stopping) return
        val restorePanel = pending || processing || timeout?.isActive == true
        stopping = true; pending = false
        if (message != null) controller.reportError(message)
        if (restorePanel) OverlayService.showPanel()
        releaseProjection()
        stopSelf()
    }
    private fun releaseProjection() {
        if (instance.get() === this) instance.clear()
        display?.release(); display = null
        reader?.setOnImageAvailableListener(null, null); reader?.close(); reader = null
        val previous = projection; projection = null; previous?.stop()
    }
    override fun onDestroy() {
        stopping = true; scope.cancel(); releaseProjection()
        stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy()
    }
}
