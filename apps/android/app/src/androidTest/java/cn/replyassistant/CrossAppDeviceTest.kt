package cn.replyassistant

import android.content.ComponentName
import android.content.Intent
import android.os.SystemClock
import android.app.UiAutomation
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Configurator
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import cn.replyassistant.platform.ChatAccessibilityService
import cn.replyassistant.platform.OverlayService
import cn.replyassistant.platform.ImageImporter
import cn.replyassistant.platform.CaptureService
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Exercises only a separate offline fixture app, never installed real chat accounts. */
@RunWith(AndroidJUnit4::class)
class CrossAppDeviceTest {
    @Test fun floatingPanelKeepsItsHeightAndActionsAboveTheKeyboard() {
        val controller = (context.applicationContext as AssistantApplication).controller
        val positions = context.getSharedPreferences("overlay_position", android.content.Context.MODE_PRIVATE)
        val previousHeight = positions.getFloat("panel_height", .52f)
        var id = ""
        ActivityScenario.launch(MainActivity::class.java).use {
            device.executeShellCommand("appops set cn.replyassistant SYSTEM_ALERT_WINDOW allow")
            device.executeShellCommand("pm grant cn.replyassistant android.permission.POST_NOTIFICATIONS")
            try {
                main {
                    controller.closePreview()
                    id = controller.createArchive("合成面板对象", "测试")
                    controller.mutateArchive(id) { it.copy(draft = cn.replyassistant.domain.ReplyDraft(
                        contextRevision = it.revision, alternatives = listOf("好呀，周末见", "老地方喝咖啡？", "下午几点方便"),
                        alternativeLabels = listOf("简短接话", "继续聊", "问清楚"))) }
                    context.startForegroundService(Intent(context, OverlayService::class.java))
                }
                openFixture()
                val bubble = By.desc("打开回复面板")
                assertTrue(device.wait(Until.hasObject(bubble), 5_000))
                device.findObject(bubble).click()
                val grip = By.desc("拖动调整面板高度")
                assertTrue(device.wait(Until.hasObject(grip), 5_000))
                val handle = device.findObject(grip).visibleBounds
                val heightBefore = positions.getFloat("panel_height", .52f)
                device.swipe(handle.centerX(), handle.centerY(), handle.centerX(), handle.centerY() + device.displayHeight / 4, 40)
                waitFor("Panel drag should save its height") { positions.getFloat("panel_height", .52f) > heightBefore }
                val heightAfter = positions.getFloat("panel_height", .52f)
                device.findObject(By.text("收起")).click()
                assertTrue(device.wait(Until.hasObject(bubble), 5_000))
                device.findObject(bubble).click()
                assertTrue(device.wait(Until.hasObject(grip), 5_000))
                assertEquals(heightAfter, positions.getFloat("panel_height", .52f), 0f)
                device.findObject(By.text("编辑")).click()
                val input = By.pkg("cn.replyassistant").clazz("android.widget.EditText")
                assertTrue(device.wait(Until.hasObject(input), 5_000))
                device.findObject(input).click()
                val keyboardPackage = device.executeShellCommand("settings get secure default_input_method").trim().substringBefore("/")
                assertTrue("Editing should show the system keyboard", device.wait(Until.hasObject(By.pkg(keyboardPackage)), 5_000))
                SystemClock.sleep(500)
                val keyboardTop = device.findObject(By.pkg(keyboardPackage)).visibleBounds.top
                device.executeShellCommand("screencap -p /sdcard/mobile-keyboard-0.5.0.png")
                listOf("复制", "完成编辑").forEach { label ->
                    val action = device.findObject(By.text(label))
                    assertNotNull("$label should remain visible while typing", action)
                    assertTrue("$label must stay above the keyboard", action.visibleBounds.bottom <= keyboardTop)
                }
                assertFalse("Capture controls should give space to editing", device.hasObject(By.text("截屏")))
                device.pressBack()
            } finally {
                main { context.stopService(Intent(context, OverlayService::class.java)); controller.deleteArchive(id) }
                positions.edit().putFloat("panel_height", previousHeight).commit()
                device.executeShellCommand("appops set cn.replyassistant SYSTEM_ALERT_WINDOW default")
            }
        }
    }
    @Test fun readingLayoutGetsVisibleTextAndExcludesUnsentInput() {
        ActivityScenario.launch(MainActivity::class.java).use {
            withAccessibility {
                openFixture("不要读取的合成未发送草稿")
                main {
                    ChatAccessibilityService.rememberTarget()
                    val layout=ChatAccessibilityService.readLayout()!!
                    assertTrue(layout.contains("合成聊天"))
                    assertTrue(layout.contains("位置="))
                    assertFalse(layout.contains("不要读取的合成未发送草稿"))
                }
            }
        }
    }
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val device get(): UiDevice {
        // UiAutomation otherwise suppresses the very accessibility service being exercised.
        Configurator.getInstance().uiAutomationFlags = UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES
        return UiDevice.getInstance(instrumentation)
    }
    private fun main(block: () -> Unit) { instrumentation.runOnMainSync(block) }
    private fun waitFor(message: String, timeout: Long = 15_000, condition: () -> Boolean) {
        val end = SystemClock.uptimeMillis() + timeout
        while (SystemClock.uptimeMillis() < end) { if (condition()) return; SystemClock.sleep(100) }
        fail(message)
    }
    private fun openFixture(preset: String = "") {
        context.startActivity(Intent().setComponent(ComponentName("cn.replyassistant.fixture", "cn.replyassistant.fixture.FixtureActivity"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK).putExtra("preset", preset))
        assertTrue(device.wait(Until.hasObject(By.textContains("合成聊天（不联网）")), 10_000))
    }
    private fun withAccessibility(block: () -> Unit) {
        val previous = device.executeShellCommand("settings get secure enabled_accessibility_services").trim()
        val enabled = device.executeShellCommand("settings get secure accessibility_enabled").trim()
        val entries = if (previous == "null" || previous.isBlank()) emptyList() else previous.split(":")
        val own = "cn.replyassistant/cn.replyassistant.platform.ChatAccessibilityService"
        device.executeShellCommand("settings put secure enabled_accessibility_services ${(entries + own).distinct().joinToString(":")}")
        device.executeShellCommand("settings put secure accessibility_enabled 1")
        try { waitFor("Accessibility service should connect") { ChatAccessibilityService.connected() }; block() }
        finally {
            if (previous == "null" || previous.isBlank()) device.executeShellCommand("settings delete secure enabled_accessibility_services")
            else device.executeShellCommand("settings put secure enabled_accessibility_services $previous")
            if (enabled != "null") device.executeShellCommand("settings put secure accessibility_enabled $enabled")
        }
    }
    @Test fun readingCurrentChatLeavesTheInputEmptyAndDoesNotSend() {
        ActivityScenario.launch(MainActivity::class.java).use {
            withAccessibility {
                openFixture()
                waitFor("Fixture's accessible window should be ready") {
                    var target: String? = null
                    main { target = ChatAccessibilityService.rememberTarget() }
                    target == "cn.replyassistant.fixture"
                }
                main { assertEquals("cn.replyassistant.fixture", ChatAccessibilityService.rememberTarget()); assertNotNull(ChatAccessibilityService.readLayout()) }
                assertEquals("", device.findObject(By.pkg("cn.replyassistant.fixture").clazz("android.widget.EditText")).text)
                assertNotNull(device.findObject(By.text("发送按钮点击次数：0")))
            }
        }
    }
    @Test fun readingCurrentChatPreservesAndExcludesAnExistingUserDraft() {
        ActivityScenario.launch(MainActivity::class.java).use {
            withAccessibility {
                openFixture("原有草稿，请保留")
                main { ChatAccessibilityService.rememberTarget(); assertFalse(ChatAccessibilityService.readLayout()!!.contains("原有草稿，请保留")) }
                assertNotNull(device.findObject(By.text("原有草稿，请保留")))
                assertNotNull(device.findObject(By.text("发送按钮点击次数：0")))
            }
        }
    }
    @Test fun floatingScreenshotReusesConsentAndStopsWhenAssistantCloses() {
        val application = context.applicationContext as AssistantApplication
        ActivityScenario.launch(MainActivity::class.java).use {
            device.executeShellCommand("appops set cn.replyassistant SYSTEM_ALERT_WINDOW allow")
            device.executeShellCommand("pm grant cn.replyassistant android.permission.POST_NOTIFICATIONS")
            try {
                main { application.controller.closePreview(); context.startForegroundService(Intent(context, OverlayService::class.java)) }
                waitFor("Overlay should start") { OverlayService.running() }
                openFixture()
                SystemClock.sleep(400)
                val density = context.resources.displayMetrics.density
                device.click(device.displayWidth - 12 - (28 * density).toInt(), device.displayHeight / 2 + 80)
                val consent = By.text(java.util.regex.Pattern.compile("Share screen|Start now|立即开始|开始共享|共享屏幕|开始录制"))
                assertTrue("Bubble opens panel", device.wait(Until.hasObject(By.text("截屏")), 5_000))
                assertFalse("Opening panel must not ask capture consent", device.hasObject(consent))
                assertFalse(CaptureService.active())
                device.findObject(By.text("截屏")).click()
                assertTrue("System screenshot consent should appear", device.wait(Until.hasObject(consent), 10_000))
                device.findObject(consent).click()
                waitFor("One screenshot should be saved without requiring OCR", 30_000) { application.controller.state.value.preview?.pages?.isNotEmpty() == true }
                val page = application.controller.state.value.preview!!.pages.single()
                assertTrue(page.rows.isEmpty())
                val recognized = runBlocking { ImageImporter(context).recognize(page) }
                val text = recognized.rows.joinToString("\n") { row -> row.text }
                java.io.File(page.path).copyTo(java.io.File(context.filesDir,"synthetic-first-capture.jpg"), overwrite = true)
                assertTrue("Must capture external fixture content: $text", text.contains("有空") && text.contains("咖啡"))
                assertTrue("Session must remain available", CaptureService.active())
                main { OverlayService.hidePanel() }
                openFixture("第二次截图的新内容")
                assertTrue("Fixture must display changed content", device.wait(Until.hasObject(By.text("第二次截图的新内容")), 5_000))
                SystemClock.sleep(400)
                assertEquals("No screenshot without another button press", 1, application.controller.state.value.preview!!.pages.size)
                device.click(device.displayWidth - 12 - (28 * density).toInt(), device.displayHeight / 2 + 80)
                assertTrue(device.wait(Until.hasObject(By.text("截屏")), 5_000))
                assertEquals(1, application.controller.state.value.preview!!.pages.size)
                device.findObject(By.text("补充前文")).click()
                waitFor("Second screenshot should arrive without another consent", 20_000) { application.controller.state.value.preview?.pages?.size == 2 }
                assertFalse(device.hasObject(consent))
                assertTrue(CaptureService.active())
                val second = runBlocking { ImageImporter(context).recognize(application.controller.state.value.preview!!.pages.last()) }
                java.io.File(application.controller.state.value.preview!!.pages.last().path).copyTo(java.io.File(context.filesDir,"synthetic-second-capture.jpg"), overwrite = true)
                assertTrue("Second screenshot must contain the changed fixture: ${second.rows.joinToString { it.text }}",
                    second.rows.any { it.text.contains("第二次") && it.text.contains("新内容") })
                assertEquals(application.controller.state.value.selectedArchiveId, application.controller.state.value.preview!!.archiveId)
                main { context.startService(Intent(context, CaptureService::class.java).setAction(CaptureService.STOP)) }
                waitFor("Explicit stop must release consent") { !CaptureService.active() }
                main { OverlayService.hidePanel() }
                SystemClock.sleep(400)
                device.click(device.displayWidth - 12 - (28 * density).toInt(), device.displayHeight / 2 + 80)
                assertTrue(device.wait(Until.hasObject(By.text("截屏")), 5_000))
                device.findObject(By.text("补充前文")).click()
                assertTrue("Stopped session needs new consent", device.wait(Until.hasObject(consent), 10_000))
                device.findObject(consent).click()
                waitFor("New consent can capture again", 20_000) { application.controller.state.value.preview?.pages?.size == 3 }
                main { context.stopService(Intent(context, OverlayService::class.java)) }
                waitFor("Closing assistant must release capture authorization") { !CaptureService.active() }
            } finally {
                main { context.stopService(Intent(context, OverlayService::class.java)); application.controller.closePreview() }
                device.executeShellCommand("appops set cn.replyassistant SYSTEM_ALERT_WINDOW default")
            }
        }
    }
    @Test fun draggingBubbleDocksAndRemembersWithoutOpeningOrCapturing() {
        val positions = context.getSharedPreferences("overlay_position", android.content.Context.MODE_PRIVATE)
        ActivityScenario.launch(MainActivity::class.java).use {
            device.executeShellCommand("appops set cn.replyassistant SYSTEM_ALERT_WINDOW allow")
            device.executeShellCommand("pm grant cn.replyassistant android.permission.POST_NOTIFICATIONS")
            try {
                positions.edit().clear().commit()
                main { context.startForegroundService(Intent(context, OverlayService::class.java)) }
                openFixture()
                val bubble = By.desc("打开回复面板")
                assertTrue(device.wait(Until.hasObject(bubble),5_000))
                val original = device.findObject(bubble).visibleBounds
                device.swipe(original.centerX(),original.centerY(),50,device.displayHeight * 3/4,35)
                waitFor("Drag position should be persisted") { positions.contains("y") }
                assertFalse(positions.getBoolean("right",true))
                assertFalse(CaptureService.active())
                assertFalse(device.hasObject(By.text("截屏")))
                val moved = device.findObject(bubble).visibleBounds
                main { context.stopService(Intent(context,OverlayService::class.java)) }
                waitFor("Overlay stops") { !OverlayService.running() }
                main { context.startForegroundService(Intent(context,OverlayService::class.java)) }
                assertTrue(device.wait(Until.hasObject(bubble),5_000))
                SystemClock.sleep(400)
                val restored = device.findObject(bubble).visibleBounds
                assertEquals(moved.left,restored.left)
                assertTrue(kotlin.math.abs(moved.top-restored.top) < 5)
            } finally {
                main { context.stopService(Intent(context,OverlayService::class.java)) }
                positions.edit().clear().commit()
                device.executeShellCommand("appops set cn.replyassistant SYSTEM_ALERT_WINDOW default")
            }
        }
    }

    @Test fun overlayConsultationOpensFullAppWithFixedQuestionAndImagePicker() {
        val controller = (context.applicationContext as AssistantApplication).controller
        var id = ""
        main { context.startActivity(Intent(context,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        run {
            device.executeShellCommand("appops set cn.replyassistant SYSTEM_ALERT_WINDOW allow")
            device.executeShellCommand("pm grant cn.replyassistant android.permission.POST_NOTIFICATIONS")
            try {
                main {
                    controller.closePreview(); id = controller.createArchive("SyntheticConsultRoute","测试")
                    context.startForegroundService(Intent(context,OverlayService::class.java))
                }
                openFixture()
                assertTrue(device.wait(Until.hasObject(By.desc("打开回复面板")),5_000))
                device.findObject(By.desc("打开回复面板")).click()
                assertTrue(device.wait(Until.hasObject(By.text("更多")),5_000))
                device.findObject(By.text("更多")).click()
                assertTrue(device.wait(Until.hasObject(By.text("问军师")),5_000))
                device.findObject(By.text("问军师")).click()
                assertTrue(device.wait(Until.hasObject(By.text("狗头军师 · SyntheticConsultRoute")),5_000))
                assertTrue(device.findObject(By.text("你想问什么？")).visibleBounds.top > device.displayHeight/2)
                assertNotNull(device.findObject(By.text("补充截图")))
                assertEquals(id,controller.state.value.advisorArchiveId)
                assertFalse(CaptureService.active())
            } finally {
                main { controller.closeAdvisor(); controller.deleteArchive(id); context.stopService(Intent(context,OverlayService::class.java)) }
                device.executeShellCommand("appops set cn.replyassistant SYSTEM_ALERT_WINDOW default")
            }
        }
    }
}
