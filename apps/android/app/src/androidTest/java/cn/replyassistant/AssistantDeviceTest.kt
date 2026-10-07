package cn.replyassistant

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import cn.replyassistant.data.LocalStore
import cn.replyassistant.data.SecureSettings
import cn.replyassistant.domain.*
import cn.replyassistant.platform.ImageImporter
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AssistantDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    @Test fun navigationAndArchiveCreation() {
        compose.onNodeWithText("聊天档案").performClick()
        compose.onNodeWithText("新建聊天档案").performClick()
        compose.onNodeWithText("名称，例如小王").performTextInput("合成测试对象")
        compose.onNodeWithText("创建").performClick()
        compose.onNodeWithText("合成测试对象 · 通用截图").assertExists()
        compose.onNodeWithText("设置").performClick()
        compose.onNodeWithText("多模态回复模型").assertExists()
    }
    @Test fun sqliteSnapshotsAndDraftsSurviveReopen() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val archive = ContextEngine.append(ChatArchive(name = "合成持久化"), listOf(ChatMessage(speaker = Speaker.OTHER, text = "消息")))
            .let { it.copy(draft = ReplyDraft(contextRevision = it.revision, alternatives = listOf("未发送草稿"), state = DraftState.COPIED)) }
        LocalStore(context, "synthetic-test.db").use { it.save(listOf(archive), PreviewSession(archiveId = archive.id)) }
        LocalStore(context, "synthetic-test.db").use {
            val loaded = it.archives().single()
            assertEquals("未发送草稿", loaded.draft!!.text)
            assertEquals(1, loaded.messages.size)
            assertEquals(archive.id, it.session()!!.archiveId)
        }
    }
    @Test fun modelCredentialsUseKeystoreAndRoundtrip() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val settings = SecureSettings(context, "synthetic-test-settings")
        settings.save(ModelSettings(textKey = "synthetic-key"))
        assertEquals("synthetic-key", settings.read().textKey)
        val stored = context.getSharedPreferences("synthetic-test-settings", 0).getString("encrypted", "")!!
        assertFalse(stored.contains("synthetic-key"))
    }
    @Test fun bundledChineseOCRWorksWithoutGooglePlayServicesDownload() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val bitmap = Bitmap.createBitmap(1200, 400, Bitmap.Config.ARGB_8888)
        Canvas(bitmap).apply { drawColor(Color.WHITE); drawText("周末一起喝咖啡", 70f, 160f, Paint().apply { color = Color.BLACK; textSize = 70f; isAntiAlias = true }) }
        val page = ImageImporter(context).fromBitmap(bitmap, recognize = true)
        assertTrue(page.rows.joinToString("") { it.text }.contains("咖啡"))
        assertTrue(page.rows.all { it.speaker == Speaker.UNKNOWN && it.uncertain })
        java.io.File(page.path).delete(); bitmap.recycle()
    }
}
