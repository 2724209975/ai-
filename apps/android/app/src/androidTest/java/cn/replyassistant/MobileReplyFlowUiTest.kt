package cn.replyassistant

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import cn.replyassistant.data.AssistantController
import cn.replyassistant.domain.*
import cn.replyassistant.ui.AssistantTheme
import cn.replyassistant.ui.ReplyPanel
import kotlinx.coroutines.cancel
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

class MobileReplyFlowUiTest {
    @get:Rule val compose = createComposeRule()
    @Test fun panelRecreationAndHistoryReturnKeepEachEditedCandidateAndReadingPosition() {
        lateinit var controller: AssistantController
        val visible = mutableStateOf(true)
        var heightChange = 0f
        fun selectReply(index: Int) {
            val description = "回复选项${index + 1}"
            val matcher = hasContentDescription(description) or hasContentDescription("$description，已选")
            compose.onNode(hasScrollToIndexAction()).performScrollToNode(matcher)
            compose.onNode(matcher).performClick()
            compose.waitUntil(5_000) {
                compose.onAllNodesWithContentDescription("$description，已选").fetchSemanticsNodes().size == 1
            }
        }
        compose.runOnUiThread {
            controller = AssistantController(InstrumentationRegistry.getInstrumentation().targetContext, storageNamespace = "mobile-flow-${newId()}")
            val id = controller.createArchive("合成对象", "测试")
            controller.mutateArchive(id) { it.copy(messages = listOf(ChatMessage(speaker = Speaker.OTHER, text = "周末喝咖啡吗")),
                draft = ReplyDraft(contextRevision = 0, alternatives = listOf("行呀", "去老地方？", "下午如何"),
                    alternativeLabels = listOf("简短接话", "继续聊", "问清楚"))) }
        }
        try {
            compose.setContent { AssistantTheme { Box(Modifier.height(520.dp)) {
                if (visible.value) ReplyPanel(controller, compact = true, onClose = { visible.value = false },
                    onCapture = {}, onResize = { heightChange += it })
            } } }
            compose.onNodeWithContentDescription("拖动调整面板高度").performTouchInput {
                swipe(center, center + Offset(0f, 60f))
            }
            compose.runOnIdle { assertTrue(heightChange > 0) }
            selectReply(0)
            compose.onNodeWithText("回复（可修改）").performTextReplacement("行呀，晚点见")
            selectReply(1)
            compose.onNodeWithText("回复（可修改）").performTextReplacement("老地方见吧")
            selectReply(0)
            compose.runOnIdle { assertEquals("行呀，晚点见", controller.selected()!!.draft!!.text) }
            compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("短一点"))
            compose.waitForIdle()
            val reading = controller.panelPosition(controller.selected()!!.id)
            val scrollTolerance = 3.0 * InstrumentationRegistry.getInstrumentation().targetContext.resources.displayMetrics.density
            assertTrue(reading.index > 0 || reading.offset > 0)
            compose.onNodeWithText("收起").performClick()
            compose.runOnIdle { visible.value = true }
            compose.onNodeWithText("回复（可修改）").assertExists()
            compose.runOnIdle {
                assertEquals(reading.index, controller.panelPosition(controller.selected()!!.id).index)
                assertEquals(reading.offset.toDouble(), controller.panelPosition(controller.selected()!!.id).offset.toDouble(), scrollTolerance)
            }
            val saved = controller.panelPosition(controller.selected()!!.id)
            compose.runOnUiThread { controller.openHistory(controller.selected()!!.id) }
            compose.onNodeWithText("去回复").performClick()
            compose.onNodeWithText("回复（可修改）").assertExists()
            compose.runOnIdle {
                assertEquals("行呀，晚点见", controller.selected()!!.draft!!.text)
                assertEquals(saved.index, controller.panelPosition(controller.selected()!!.id).index)
                assertEquals(saved.offset.toDouble(), controller.panelPosition(controller.selected()!!.id).offset.toDouble(), scrollTolerance)
            }
            val first = controller.selected()!!.id
            compose.runOnUiThread { controller.createArchive("另一个合成对象", "测试") }
            compose.onNodeWithContentDescription("聊天对象：另一个合成对象").assertExists()
            compose.runOnUiThread { controller.selectArchive(first) }
            compose.onNodeWithText("回复（可修改）").assertExists()
            compose.runOnIdle { assertEquals("行呀，晚点见", controller.selected()!!.draft!!.text) }
            compose.onNodeWithText("完成编辑").performClick()
            compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasContentDescription("回复选项1，已选"))
            val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
            File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "mobile-reply-0.5.0.png").outputStream().use {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        } finally { compose.runOnUiThread { controller.scope.cancel() } }
    }
}
