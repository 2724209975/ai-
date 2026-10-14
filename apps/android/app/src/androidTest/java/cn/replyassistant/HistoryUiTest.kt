package cn.replyassistant

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.test.platform.app.InstrumentationRegistry
import cn.replyassistant.data.AssistantController
import cn.replyassistant.domain.*
import cn.replyassistant.ui.*
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.encodeToJsonElement
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

class HistoryUiTest {
    @get:Rule val compose=createComposeRule()
    @Test fun historyShowsSyncedSpeechSearchesAndPreservesDraftWhileAdding(){
        lateinit var controller:AssistantController
        val draft=ReplyDraft(contextRevision=0,alternatives=listOf("未发送的私有草稿"),manuallyEdited=true)
        compose.runOnUiThread {
            controller=AssistantController(InstrumentationRegistry.getInstrumentation().targetContext,storageNamespace="history-ui-${newId()}")
            val id=controller.createArchive("合成对象A","测试")
            val remote=LinkMessage(Speaker.OTHER,"电脑已保存原文",2000,false,false,false,"source")
            controller.mutateArchive(id){it.copy(messages=listOf(ChatMessage(speaker=Speaker.ME,text="手机真实表达",timestamp=1000)),draft=draft,desktop=LinkedArchive("group",records=listOf(LinkRecord("desktop:one","message",Json.encodeToJsonElement(remote),1,1,false))))}
            val other=controller.createArchive("合成对象B","测试")
            controller.mutateArchive(other){it.copy(messages=listOf(ChatMessage(speaker=Speaker.OTHER,text="另一对象私有消息")))}
            controller.openHistory(id)
        }
        try {
            compose.setContent {AssistantTheme {HistoryScreen(controller)}}
            compose.onNodeWithText("电脑已保存原文").assertIsDisplayed()
            compose.onNodeWithText("未发送的私有草稿").assertDoesNotExist()
            compose.onNodeWithText("另一对象私有消息").assertDoesNotExist()
            val bitmap=compose.onRoot().captureToImage().asAndroidBitmap()
            File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir,"synthetic-history-ui.png").outputStream().use {bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)}
            compose.onNodeWithText("搜索").performClick()
            compose.onNodeWithText("搜索聊天内容").performTextInput("电脑")
            compose.onNodeWithText("电脑已保存原文").assertIsDisplayed()
            compose.onNodeWithText("手机真实表达").assertDoesNotExist()
            compose.onNodeWithText("收起搜索").performClick()
            compose.onNodeWithText("补充记录").performClick()
            compose.onNodeWithText("原文或已确认的图片说明").performTextInput("补充的真实发言")
            compose.onNodeWithText("添加").performClick()
            compose.runOnIdle {
                val archive=controller.state.value.archives.first()
                assertEquals(2,archive.messages.size);assertEquals(draft,archive.draft)
                assertEquals("补充的真实发言",archive.messages.last().text)
            }
            compose.onNodeWithText("返回").performClick()
            compose.runOnIdle {assertNull(controller.state.value.historyArchiveId)}
        }finally {compose.runOnUiThread {controller.scope.cancel()}}
    }
    @Test fun replyPanelHasDirectHistoryEntryWithoutMore(){
        lateinit var controller:AssistantController
        compose.runOnUiThread {
            controller=AssistantController(InstrumentationRegistry.getInstrumentation().targetContext,storageNamespace="history-entry-${newId()}")
            val id=controller.createArchive("合成对象","测试")
            controller.mutateArchive(id){it.copy(messages=listOf(ChatMessage(speaker=Speaker.OTHER,text="保存的合成聊天")))}
        }
        try {
            compose.setContent {AssistantTheme {ReplyPanel(controller,onClose={})}}
            compose.onNodeWithText("记录").assertIsDisplayed().performClick()
            compose.onNodeWithText("保存的合成聊天",substring=true).assertIsDisplayed()
            compose.onNodeWithText("查看全部").performClick()
            compose.onNodeWithText("去回复").performClick()
            compose.onNodeWithText("辅助回复").assertIsDisplayed()
        }finally {compose.runOnUiThread {controller.scope.cancel()}}
    }
}
