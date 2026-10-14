package cn.replyassistant

import androidx.compose.ui.test.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.test.platform.app.InstrumentationRegistry
import cn.replyassistant.data.AssistantController
import cn.replyassistant.domain.*
import cn.replyassistant.ui.*
import kotlinx.coroutines.cancel
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

class PersonalAdvisorUiTest {
    @Test fun copyCanKeepPanelOpenAndStillRemainsOnlyADraft() {
        lateinit var controller:AssistantController
        var closed=false
        compose.runOnUiThread {
            controller=AssistantController(InstrumentationRegistry.getInstrumentation().targetContext,storageNamespace="copy-open-${newId()}")
            val id=controller.createArchive("合成对象","测试")
            controller.saveSettings(ModelSettings(collapseAfterAction=false))
            controller.mutateArchive(id){it.copy(draft=ReplyDraft(contextRevision=0,alternatives=listOf("第一条","第二条","第三条")))}
        }
        try {
            compose.setContent {AssistantTheme {Box(Modifier.height(420.dp)) {ReplyPanel(controller,compact=true,onClose={closed=true},onCapture={})}}}
            compose.onNodeWithText("读取聊天").assertIsDisplayed()
            compose.onNodeWithText("复制").assertIsDisplayed().performClick()
            compose.runOnIdle {assertFalse(closed);assertEquals(DraftState.COPIED,controller.selected()!!.draft!!.state);assertTrue(controller.selected()!!.messages.isEmpty())}
        } finally {compose.runOnUiThread {controller.scope.cancel()}}
    }
    @get:Rule val compose = createComposeRule()
    @Test fun preferencesAndConsultationTransferKeepManualDraftAndNeverSend() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        lateinit var controller: AssistantController
        val turn = ConsultTurn(question = "合成咨询问题",analysis = AdvisorAnalysis(summary = "合成分析",hypotheses = listOf("这只是推测")),replies = listOf("合成回复A"))
        compose.runOnUiThread {
            controller = AssistantController(context,storageNamespace = "synthetic-ui-${newId()}")
            val id = controller.createArchive("SyntheticAdvisor","测试")
            controller.mutateArchive(id) { it.copy(skill = SkillConfig(enabled = true),draft = ReplyDraft(contextRevision = 0,alternatives = listOf("原手工稿"),manuallyEdited = true),consultation = Consultation(turns = listOf(turn))) }
        }
        try {
            compose.setContent { AssistantTheme { ReplyPanel(controller,onClose = {},onPick = {}) } }
            compose.onNodeWithText("太长了").assertDoesNotExist()
            compose.onNodeWithText("更多").performClick()
            compose.onNodeWithText("记住这个偏好 / 管理偏好").performScrollTo().performClick()
            compose.onNodeWithText("长期回复偏好").performTextInput("不使用感叹号")
            compose.onNodeWithText("保存",useUnmergedTree = true).performClick()
            compose.runOnIdle { assertEquals("不使用感叹号",controller.selected()!!.preferences.single().text) }
            compose.onNodeWithText("问军师").performScrollTo().performClick()
            compose.onNodeWithText("狗头军师 · SyntheticAdvisor").assertIsDisplayed()
            compose.onNodeWithText("合成分析").performScrollTo().assertIsDisplayed()
            val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
            File(context.filesDir,"synthetic-advisor-ui.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) }
            compose.onNodeWithText("用作回复").performScrollTo().performClick()
            compose.onNodeWithText("辅助回复").assertIsDisplayed()
            compose.runOnIdle {
                assertEquals("合成回复A",controller.selected()!!.draft!!.text)
                assertEquals("原手工稿",controller.selected()!!.draftHistory.single().text)
                assertTrue(controller.selected()!!.messages.isEmpty())
                assertEquals(DraftState.EDITING,controller.selected()!!.draft!!.state)
            }
            val reply = compose.onRoot().captureToImage().asAndroidBitmap()
            File(context.filesDir,"synthetic-reply-ui.png").outputStream().use { reply.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) }
        } finally { compose.runOnUiThread { controller.scope.cancel() } }
    }

    @OptIn(ExperimentalLayoutApi::class)
    @Test fun compactPanelStartsSimpleAndKeepsEditedDraftWhenMoreIsToggled() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        lateinit var controller: AssistantController
        compose.runOnUiThread {
            controller = AssistantController(context,storageNamespace = "synthetic-simple-ui-${newId()}")
            val id = controller.createArchive("SyntheticSimple","测试")
            controller.mutateArchive(id) { it.copy(draft = ReplyDraft(contextRevision = 0,alternatives = listOf("原回复", "第二条回复", "第三条回复"))) }
        }
        try {
            // This fixed test box already ends above the keyboard. Real overlay resizing
            // and keyboard visibility are exercised by CrossAppDeviceTest.
            compose.setContent { AssistantTheme { Box(Modifier.height(420.dp).consumeWindowInsets(WindowInsets.ime)) { ReplyPanel(controller,compact = true,onClose = {},onCapture = {}) } } }
            compose.onNodeWithText("填入").assertDoesNotExist()
            compose.onNodeWithText("确认通过通知发送").assertDoesNotExist()
            compose.onNodeWithText("复制").assertIsDisplayed()
            compose.onNodeWithText("截屏").assertIsDisplayed()
            compose.onNodeWithText("原回复").assertIsDisplayed()
            compose.onNodeWithText("第二条回复").assertIsDisplayed()
            compose.onNodeWithText("第三条回复").assertIsDisplayed()
            compose.onNodeWithContentDescription("回复选项2").performClick()
            compose.runOnIdle { assertEquals("第二条回复",controller.selected()!!.draft!!.text) }
            compose.onNodeWithContentDescription("回复选项1").performClick()
            val panel = compose.onRoot().captureToImage().asAndroidBitmap()
            File(context.filesDir,"synthetic-three-options-ui.png").outputStream().use { panel.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) }
            compose.onNodeWithText("太长了").assertDoesNotExist()
            compose.onNodeWithText("想怎么回（可选）").assertDoesNotExist()
            compose.onNodeWithText("完成编辑").assertIsDisplayed()
            compose.onNodeWithText("回复（可修改）").performScrollTo().performTextReplacement("第一条手工修改")
            compose.onNodeWithContentDescription("回复选项2").performSemanticsAction(SemanticsActions.OnClick) { it() }
            compose.runOnIdle {
                assertEquals("第二条回复",controller.selected()!!.draft!!.text)
                assertEquals("第一条手工修改",controller.selected()!!.draftHistory.last().text)
            }
            compose.onNodeWithText("回复（可修改）").performScrollTo().performTextReplacement("保留我的编辑")
            compose.onNodeWithText("更多").performClick()
            compose.onNode(hasScrollAction()).performScrollToNode(hasText("太长了"))
            compose.onNodeWithText("太长了").assertIsDisplayed()
            compose.onNodeWithText("收起更多").performClick()
            compose.onNodeWithText("太长了").assertDoesNotExist()
            compose.runOnIdle { assertEquals("保留我的编辑",controller.selected()!!.draft!!.text) }
        } finally { compose.runOnUiThread { controller.scope.cancel() } }
    }

    @Test fun longCandidateKeepsActionsVisibleAndCopyClosesWithoutSending() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        lateinit var controller: AssistantController
        var closed = false
        compose.runOnUiThread {
            controller = AssistantController(context,storageNamespace = "synthetic-fixed-actions-${newId()}")
            val id = controller.createArchive("SyntheticLong","测试")
            controller.mutateArchive(id) { it.copy(draft = ReplyDraft(contextRevision = 0,alternatives = listOf("很长的合成回复。".repeat(45),"短回复2","短回复3"))) }
        }
        try {
            compose.setContent { AssistantTheme { Box(Modifier.height(420.dp)) { ReplyPanel(controller,compact = true,onClose = { closed = true },onCapture = {}) } } }
            compose.onNodeWithText("填入").assertDoesNotExist()
            compose.onNodeWithText("复制").assertIsDisplayed().performClick()
            compose.runOnIdle {
                assertTrue(closed)
                assertEquals(DraftState.COPIED,controller.selected()!!.draft!!.state)
                assertTrue(controller.selected()!!.messages.isEmpty())
            }
        } finally { compose.runOnUiThread { controller.scope.cancel() } }
    }

    @Test fun opacitySliderPreservesUnsavedModelConfiguration() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        lateinit var controller: AssistantController
        compose.runOnUiThread { controller = AssistantController(context,storageNamespace = "synthetic-opacity-ui-${newId()}") }
        try {
            compose.setContent { AssistantTheme { LazyColumn { item { SettingsPanel(controller,{}) } } } }
            compose.onNodeWithText("多模态模型名称").performTextInput("unfinished-model")
            compose.onNodeWithContentDescription("悬浮按钮透明度").performScrollTo()
                .performSemanticsAction(SemanticsActions.SetProgress) { it(60f) }
            compose.onNodeWithContentDescription("回复面板透明度").performScrollTo()
                .performSemanticsAction(SemanticsActions.SetProgress) { it(30f) }
            compose.onNodeWithText("unfinished-model").assertExists()
            compose.runOnIdle {
                assertEquals(.4f,controller.state.value.settings.bubbleOpacity,.001f)
                assertEquals(.7f,controller.state.value.settings.panelOpacity,.001f)
                assertEquals("",controller.state.value.settings.visionModel)
                controller.saveOverlayOpacity()
            }
        } finally { compose.runOnUiThread { controller.scope.cancel() } }
    }
}
