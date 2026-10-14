package cn.replyassistant

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import cn.replyassistant.data.AssistantController
import cn.replyassistant.domain.*
import cn.replyassistant.ui.*
import kotlinx.coroutines.cancel
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class HistoryRepairUiTest {
    @get:Rule val compose=createComposeRule()
    @Test fun repairRequiresConfirmationKeepsDraftAndCanBeUndone(){
        lateinit var controller:AssistantController
        fun batch(source:String)=listOf(ChatMessage(speaker=Speaker.OTHER,text="周末一起去喝咖啡吗",origin=Origin.SCREENSHOT,sourceId=source),ChatMessage(speaker=Speaker.ME,text="我周日下午可以",origin=Origin.SCREENSHOT,sourceId=source))
        val originals=batch("first")+batch("second")
        val draft=ReplyDraft(contextRevision=0,alternatives=listOf("保留的手工草稿"),manuallyEdited=true)
        compose.runOnUiThread {
            controller=AssistantController(InstrumentationRegistry.getInstrumentation().targetContext,storageNamespace="repair-ui-${newId()}")
            val id=controller.createArchive("合成整理对象","测试")
            controller.mutateArchive(id){it.copy(messages=originals,draft=draft)}
            controller.openHistory(id)
        }
        try {
            compose.setContent {AssistantTheme {HistoryScreen(controller)}}
            compose.onNodeWithText("整理重复").performClick()
            compose.runOnIdle {assertEquals(4,controller.selected()!!.messages.size)}
            compose.onNodeWithText("确认整理").performClick()
            compose.runOnIdle {assertEquals(2,controller.selected()!!.messages.size);assertEquals(draft,controller.selected()!!.draft);assertEquals(originals,controller.selected()!!.historyUndo)}
            compose.onNodeWithText("撤销上次整理").performClick()
            compose.runOnIdle {assertEquals(originals,controller.selected()!!.messages);assertEquals(draft,controller.selected()!!.draft)}
        }finally {compose.runOnUiThread {controller.scope.cancel()}}
    }
    @Test fun staleRepairCannotOverwriteNewIncomingMessage(){
        lateinit var controller:AssistantController
        compose.runOnUiThread {
            controller=AssistantController(InstrumentationRegistry.getInstrumentation().targetContext,storageNamespace="repair-stale-${newId()}")
            val id=controller.createArchive("合成对象","测试")
            val first=listOf(ChatMessage(speaker=Speaker.OTHER,text="周末一起去喝咖啡吗",origin=Origin.SCREENSHOT,sourceId="first"),ChatMessage(speaker=Speaker.ME,text="我周日下午可以",origin=Origin.SCREENSHOT,sourceId="first"))
            controller.mutateArchive(id){it.copy(messages=first+first.map {row->row.copy(id=newId(),sourceId="second")})}
            val snapshot=controller.selected()!!;val proposed=ScreenshotStitcher.repair(snapshot.messages)
            controller.reviseMessages(id,snapshot.messages+ChatMessage(speaker=Speaker.OTHER,text="新到的真实消息"))
            try{controller.repairHistory(id,snapshot.revision,proposed);fail("Stale preview must be refused")}catch(_:IllegalArgumentException){}
            assertEquals(5,controller.selected()!!.messages.size)
            controller.scope.cancel()
        }
    }
}
