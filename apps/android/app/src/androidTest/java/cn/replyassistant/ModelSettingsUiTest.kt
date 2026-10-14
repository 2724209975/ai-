package cn.replyassistant

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.platform.app.InstrumentationRegistry
import cn.replyassistant.data.AssistantController
import cn.replyassistant.domain.*
import cn.replyassistant.ui.*
import kotlinx.coroutines.cancel
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import java.io.File
import android.graphics.Bitmap

class ModelSettingsUiTest {
    @get:Rule val compose=createEmptyComposeRule()
    @Test fun modelsHaveTheirOwnPageAndFeesStartCollapsed() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val namespace="model-page-ui-${newId()}"
        File(context.filesDir,"model-settings-ui-ready.txt").writeText("ready")
        var activity:ComponentActivity?=null
        val end=android.os.SystemClock.uptimeMillis()+30000
        while(activity==null&&android.os.SystemClock.uptimeMillis()<end){
            InstrumentationRegistry.getInstrumentation().runOnMainSync {activity=ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).filterIsInstance<ComponentActivity>().firstOrNull()}
            if(activity==null)Thread.sleep(100)
        }
        require(activity!=null){"UI_TEST_HOST_NOT_FOREGROUND"}
        lateinit var controller:AssistantController
        compose.runOnUiThread {
            controller=AssistantController(context,storageNamespace=namespace)
            controller.saveSettings(QwenPreset.apply(controller.state.value.settings).copy(textKey="synthetic-key",qualityKey="synthetic-key",visionKey="synthetic-key"))
            activity!!.setContent {AssistantTheme {AssistantApp(controller,{}, {})}}
        }
        try {
            compose.onNodeWithText("模型配置",useUnmergedTree=true).performClick()
            compose.onNodeWithText("低成本模型").assertExists()
            compose.onNodeWithText("费用概览").assertDoesNotExist()
            compose.onNodeWithText("悬浮透明度").assertDoesNotExist()
            compose.onNodeWithText("输入价格（元 / 百万 token）").assertDoesNotExist()
            File(context.filesDir,"model-settings-ui.png").outputStream().use {compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG,100,it)}
            val list=compose.onNode(hasScrollToIndexAction())
            list.performScrollToNode(hasText("保存模型配置"))
            compose.onNodeWithText("保存模型配置").performClick()
            assertEquals("qwen3.7-flash",controller.state.value.settings.textModel)
            assertEquals("synthetic-key",controller.state.value.settings.textKey)
            compose.onNodeWithText("设置",useUnmergedTree=true).performClick()
            compose.onNodeWithText("费用概览").assertIsDisplayed()
            compose.onNodeWithText("今日 0 次调用 · 预留 0 token").assertDoesNotExist()
            compose.onNodeWithText("低成本模型").assertDoesNotExist()
            File(context.filesDir,"fees-summary-ui.png").outputStream().use {compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG,100,it)}
            list.performScrollToNode(hasText("查看调用记录"))
            compose.onNodeWithText("查看调用记录").performClick()
            compose.onNodeWithText("今日 0 次调用 · 预留 0 token").assertExists()
        } finally {
            compose.runOnUiThread {controller.scope.cancel()}
            context.deleteDatabase(namespace+".db")
            context.deleteSharedPreferences(namespace+"_settings")
            context.deleteSharedPreferences(namespace+"_v2_usage")
            File(context.filesDir,"model-settings-ui-ready.txt").delete()
        }
    }
}
