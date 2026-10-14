package cn.replyassistant

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import cn.replyassistant.ai.ModelClient
import cn.replyassistant.data.*
import cn.replyassistant.domain.*
import cn.replyassistant.ui.AssistantTheme
import cn.replyassistant.ui.ReplyPanel
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

@Serializable private data class PrivateQwenModel(val modelId:String,val baseUrl:String,val apiKey:String,val inputPerMillion:Double,val outputPerMillion:Double)
@Serializable private data class PrivateQwenImport(val economy:PrivateQwenModel,val quality:PrivateQwenModel)

/** Explicit owner-operated setup and live smoke only; never part of an automatic model run. */
class QwenImportDeviceTest {
 private val context get()=InstrumentationRegistry.getInstrumentation().targetContext
 private val json=Json {encodeDefaults=true}
 private fun mode(value:String){assumeTrue(InstrumentationRegistry.getArguments().getString("qwenMode")==value);check(BuildConfig.DEBUG)}
 private fun write(name:String,value:JsonObject){File(context.filesDir,name).writeText(value.toString())}
 @Test fun importPrivateConfiguration(){
  mode("import")
  val file=File(context.filesDir,"qwen-model-import.json")
  try {
   require(file.length() in 1..30000){"PRIVATE_CONFIG_MISSING"}
   val input=json.decodeFromString<PrivateQwenImport>(file.readText())
   fun valid(m:PrivateQwenModel){val url=m.baseUrl.toHttpUrlOrNull();require(url!=null&&url.isHttps&&url.username.isEmpty()&&url.password.isEmpty()&&url.query==null&&url.fragment==null&&
    (url.host=="dashscope.aliyuncs.com"||url.host.endsWith(".cn-beijing.maas.aliyuncs.com"))&&m.apiKey.isNotBlank()&&m.apiKey.length<=4096&&m.apiKey.all {it.code in 33..126}&&
    listOf(m.inputPerMillion,m.outputPerMillion).all {it.isFinite()&&it>0}){"PRIVATE_CONFIG_INVALID"}}
   valid(input.economy);valid(input.quality)
   require(input.economy.modelId=="qwen3.7-flash"&&input.quality.modelId=="qwen3.5-plus"){"MODEL_SCOPE_INVALID"}
   val store=SecureSettings(context);val old=store.read();val meter=MobileUsageStore(context,"");val oldUsage=meter.snapshot()
   val next=old.copy(textEndpoint=input.economy.baseUrl,textModel=input.economy.modelId,textKey=input.economy.apiKey,
    visionEndpoint=input.economy.baseUrl,visionModel=input.economy.modelId,visionKey=input.economy.apiKey,
    qualityEndpoint=input.quality.baseUrl,qualityModel=input.quality.modelId,qualityKey=input.quality.apiKey,
    textPrice=ModelPrice(input.economy.inputPerMillion,input.economy.outputPerMillion),visionPrice=ModelPrice(input.economy.inputPerMillion,input.economy.outputPerMillion),
    qualityPrice=ModelPrice(input.quality.inputPerMillion,input.quality.outputPerMillion),fastReplies=true)
   store.save(next);val loaded=store.read()
   assertTrue(loaded==next);assertTrue(old.linkConnection==loaded.linkConnection);assertTrue(oldUsage==meter.snapshot())
   write("qwen-import-result.json",buildJsonObject {put("imported",true);put("economyModel",loaded.textModel);put("qualityModel",loaded.qualityModel);put("visionModel",loaded.visionModel);put("pairingPreserved",true);put("usagePreserved",true);put("paidCalls",0)})
  } finally {file.delete()}
 }
}


class QwenTextDeviceTest {
 private val context get()=InstrumentationRegistry.getInstrumentation().targetContext
 private val json=Json {encodeDefaults=true}
 @Test fun liveTextGeneration(){
  assumeTrue(InstrumentationRegistry.getArguments().getString("qwenMode")=="text");check(BuildConfig.DEBUG)
  val settings=SecureSettings(context).read();require(settings.textModel=="qwen3.7-flash"&&settings.textKey.isNotBlank()){"QWEN_NOT_CONFIGURED"}
  val report=File(context.filesDir,"qwen-text-smoke-result.json");require(!report.exists()){"LIVE_SMOKE_ALREADY_RUN"}
  val meter=MobileUsageStore(context,"");val before=meter.snapshot();require(before.grant?.supported==true){"ORIGINAL_BUDGET_REQUIRED"}
  val http=okhttp3.OkHttpClient.Builder().connectTimeout(15,java.util.concurrent.TimeUnit.SECONDS).readTimeout(60,java.util.concurrent.TimeUnit.SECONDS).callTimeout(90,java.util.concurrent.TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).addInterceptor {chain->val response=chain.proceed(chain.request());var body=response.peekBody(1000000).string();listOf(settings.textKey,settings.visionKey,settings.qualityKey).filter {it.isNotBlank()}.forEach {body=body.replace(it,"[redacted]")};File(context.filesDir,"qwen-smoke-response-"+System.currentTimeMillis()+".json").writeText(body);response}.build()
  val client=ModelClient(http=http);client.reserveCall={s,role,model,input,output->meter.reserve(s,role,model,input,output)};client.completeCall={id,input,output,status->meter.complete(id,input,output,status)}
  val archive=ChatArchive(name="千问文字验收（合成）",platform="合成验收",messages=listOf(ChatMessage(id="86cddbe3-1c71-4643-b7c1-0cb968e608df",speaker=Speaker.OTHER,text="刚忙完一阵，终于能歇会儿了。")))
  val c=MobilePipelineV2.build(archive,"")
  try {
   val decision=runBlocking {client.decideV2(c,"简短自然，不编造本人的经历或安排",settings)};require(decision.action=="reply"&&decision.risk_level!="high"){"SMOKE_DECISION_NOT_REPLY"}
   val result=runBlocking {client.generateV2(c,decision,archive,"简短自然，不编造本人的经历或安排",settings)}
   val quality=result.alternatives.map {MobilePipelineV2.quality(c,decision,it)};require(quality.all {it.status!="blocked"}){"SMOKE_QUALITY_BLOCKED"}
   val after=meter.snapshot();assertEquals(2,after.calls.size-before.calls.size);assertTrue(after.calls.takeLast(2).all {it.status=="completed"})
   val reserved=after.spentMicroCny-before.spentMicroCny;require(reserved in 1..100000){"SMOKE_BUDGET_INVALID"}
   report.writeText(buildJsonObject {put("generated",true);put("edited",false);put("copied",false);put("model",settings.textModel);put("paidCalls",2);put("reservedMicroCny",reserved);put("decision",json.encodeToJsonElement(decision));put("alternatives",buildJsonArray {result.alternatives.forEach {add(it)}});put("alternativeLabels",buildJsonArray {result.alternativeLabels.forEach {add(it)}});put("quality",buildJsonArray {quality.forEach {add(it.status)}});put("sendCalls",0)}.toString())
  } catch(e:Exception) {
   if(!report.exists())report.writeText(buildJsonObject {put("generated",false);put("errorType",e.javaClass.simpleName);put("error",e.message.orEmpty().take(200));put("callsAdded",meter.snapshot().totalCalls-before.totalCalls);put("reservedMicroCny",meter.snapshot().spentMicroCny-before.spentMicroCny);put("sendCalls",0)}.toString())
   throw e
  }
 }
}
class QwenSetupDeviceTest {
 @get:Rule val compose=createEmptyComposeRule()
 private val context get()=InstrumentationRegistry.getInstrumentation().targetContext
 private val json=Json {encodeDefaults=true}
 @Test fun savedCandidatesEditingAndCopy(){
  assumeTrue(InstrumentationRegistry.getArguments().getString("qwenMode")=="ui");check(BuildConfig.DEBUG)
  val report=File(context.filesDir,"qwen-text-smoke-result.json");val saved=json.parseToJsonElement(report.readText()).jsonObject;require(saved["generated"]?.jsonPrimitive?.boolean==true)
  val alternatives=saved["alternatives"]!!.jsonArray.map {it.jsonPrimitive.content};val labels=saved["alternativeLabels"]!!.jsonArray.map {it.jsonPrimitive.content};val decision=json.decodeFromJsonElement<MobileDecisionV2>(saved["decision"]!!)
  val archive=ChatArchive(name="千问文字验收（合成）",platform="合成验收",messages=listOf(ChatMessage(id="synthetic-incoming",speaker=Speaker.OTHER,text="刚忙完一阵，终于能歇会儿了。")))
  val c=MobilePipelineV2.build(archive,"");val quality=alternatives.map {MobilePipelineV2.quality(c,decision,it)};val namespace="qwen-live-ui-"+newId();var controller:AssistantController?=null
  File(context.filesDir,"qwen-ui-ready.txt").writeText("ready")
  var activity:ComponentActivity?=null;val end=android.os.SystemClock.uptimeMillis()+30000
  while(activity==null&&android.os.SystemClock.uptimeMillis()<end){InstrumentationRegistry.getInstrumentation().runOnMainSync {activity=ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).filterIsInstance<ComponentActivity>().firstOrNull()};if(activity==null)Thread.sleep(100)}
  require(activity!=null){"PHONE_ACTIVITY_NOT_FOREGROUND"}
  try {
   lateinit var ui:AssistantController
   compose.runOnUiThread {
    ui=AssistantController(context,storageNamespace=namespace);controller=ui;val id=ui.createArchive(archive.name,archive.platform)
    ui.mutateArchive(id){it.copy(messages=archive.messages,draft=ReplyDraft(contextRevision=it.revision,alternatives=alternatives,contextV2=c.copy(archiveId=id),decisionV2=decision,qualityV2=quality,generationModel="qwen3.7-flash",alternativeLabels=labels))}
    activity!!.setContent {AssistantTheme {Box(Modifier.height(600.dp)){ReplyPanel(ui,compact=true,onClose={},onCapture={})}}}
   }
   val reply=hasContentDescription("回复选项1") or hasContentDescription("回复选项1，已选")
   compose.onNode(hasScrollToIndexAction()).performScrollToNode(reply);compose.onNode(reply).performClick()
   val edited="辛苦啦，先歇一会儿，慢慢来。"
   compose.onNodeWithText("回复（可修改）").performTextReplacement(edited)
   compose.runOnIdle {assertEquals(edited,ui.selected()!!.draft!!.text)}
   compose.onNodeWithText("完成编辑").performClick()
   compose.onNodeWithText("复制",useUnmergedTree=true).performClick()
   compose.runOnIdle {assertEquals(DraftState.COPIED,ui.selected()!!.draft!!.state);assertEquals(edited,(context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip?.getItemAt(0)?.text?.toString())}
   val image=compose.onRoot().captureToImage().asAndroidBitmap();File(context.filesDir,"qwen-text-smoke.png").outputStream().use {image.compress(Bitmap.CompressFormat.PNG,100,it)}
   val success=saved.toMutableMap();success["edited"]=JsonPrimitive(true);success["copied"]=JsonPrimitive(true);success["editedText"]=JsonPrimitive(edited);report.writeText(JsonObject(success).toString())
  } finally {
   compose.runOnUiThread {controller?.scope?.cancel()}
   context.deleteDatabase(namespace+".db");context.deleteSharedPreferences(namespace+"_settings");context.deleteSharedPreferences(namespace+"_v2_usage");File(context.filesDir,"qwen-ui-ready.txt").delete()
  }
 }
}
