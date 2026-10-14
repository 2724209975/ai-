package cn.replyassistant

import cn.replyassistant.domain.*
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import java.util.concurrent.TimeUnit

/** Upgrade historical synthetic responses to the independent decision/generation stages. */
class IndependentPipelineDispatcher:QueueDispatcher() {
 private val json=Json {encodeDefaults=true}
 private var recognized:MockResponse?=null
 init {setFailFast(true)}
 override fun dispatch(request:RecordedRequest):MockResponse {
  val root=json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
  val messages=root["messages"]!!.jsonArray
  val system=messages.first().jsonObject["content"]!!.jsonPrimitive.content
  if(system.contains("严格包含以下13个字段")) {
   val context=messages.last().jsonObject["content"]!!.jsonPrimitive.content
   val ids=Regex("\\[([^\\]\\n]+)\\] 对方：").findAll(context).map {it.groupValues[1].substringBefore('；')}.distinct().take(100).toList()
   val decision=MobileDecisionV2("2.0","reply","接话",MobileEmotionV2("neutral",.9),null,"自然回应","自然","short","low",emptyList(),ids,"NORMAL_REPLY",true)
   return envelope(json.encodeToString(decision))
  }
  if(system.contains("你为本人起草聊天候选")) {
   return if(super.peek().status.startsWith("HTTP/1.1 404")&&recognized!=null)recognized!!.clone().setBodyDelay(0,TimeUnit.MILLISECONDS) else super.dispatch(request)
  }
  return super.dispatch(request).also {if(system.contains("只识别本轮截图")) recognized=it.clone()}
 }
 private fun envelope(content:String)=MockResponse().setBody(buildJsonObject {put("choices",buildJsonArray {add(buildJsonObject {put("message",buildJsonObject {put("content",content)})})})}.toString())
}
