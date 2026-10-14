package cn.replyassistant.ai

import cn.replyassistant.domain.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class MobileModelPipelineTest {
 @Test fun centralMeterReservesBeforeEveryRequestAndPricesHighRoleEvenWithSharedKeys()=runTest {
  MockWebServer().use {server->server.start();val client=ModelClient(allowLocalTestHttp=true);val roles=mutableListOf<String>();var completed=0
   client.reserveCall={_,role,_,input,output->assertTrue(input>=4096);assertTrue(output>0);roles+=role;"call-$role"}
   client.completeCall={_,input,output,_->assertEquals(20L,input);assertEquals(10L,output);completed++}
   fun response(content:String)=buildJsonObject {put("choices",buildJsonArray {add(buildJsonObject {put("message",buildJsonObject {put("content",content)})})});put("usage",buildJsonObject {put("prompt_tokens",20);put("completion_tokens",10)})}.toString()
   server.enqueue(MockResponse().setBody(response(json.encodeToString(d))));server.enqueue(MockResponse().setBody(response("""{"alternatives":["我听着，你说","愿意聊聊你的感受吗","这让你很难过吧"]}""")))
   val settings=settings(server).copy(qualityKey="synthetic-low");val decision=client.decideV2(c,"",settings);client.generateV2(c,decision,a,"",settings)
   assertEquals(listOf("text","quality"),roles);assertEquals(2,completed)
   client.reserveCall={_,_,_,_,_->error("quota refused")};assertNotNull(runCatching {client.decideV2(c,"",settings)}.exceptionOrNull());assertEquals(2,server.requestCount)
  }
 }
 private val json=Json {encodeDefaults=true}
 private val a=ChatArchive(name="合成",messages=listOf(ChatMessage(id="incoming",speaker=Speaker.OTHER,text="你根本不理我，我很难过")))
 private val c=MobilePipelineV2.build(a,"")
 private val d=MobileDecisionV2("2.0","reply","回应",MobileEmotionV2("neutral",.9),null,"接话","自然","short","low",emptyList(),listOf("incoming"),"NORMAL_REPLY",false)
 private fun envelope(content:String)=buildJsonObject {put("choices",buildJsonArray {add(buildJsonObject {put("message",buildJsonObject {put("content",content)})})})}.toString()
 private fun settings(server:MockWebServer)=ModelSettings(textEndpoint=server.url("/cheap").toString(),textModel="economy",textKey="synthetic-low",qualityEndpoint=server.url("/quality").toString(),qualityModel="quality",qualityKey="synthetic-high")
 @Test fun cheapDecisionAndHighGeneratorAreTwoDirectCallsWithoutComputer()=runTest {
  MockWebServer().use {s->s.start();s.enqueue(MockResponse().setBody(envelope(json.encodeToString(d))));s.enqueue(MockResponse().setBody(envelope("""{"alternatives":["我听着，你说","愿意聊聊你的感受吗","这让你很难过吧"]}""")))
   val client=ModelClient(allowLocalTestHttp=true);val reservations=mutableListOf<Int>();client.reserveV2={_,tokens->reservations+=tokens}
   val decision=client.decideV2(c,"",settings(s));val r=client.generateV2(c,decision,a,"",settings(s))
   assertEquals(3,r.alternatives.size);assertEquals(2,s.requestCount);assertEquals(2,reservations.size)
   val first=s.takeRequest()!!;val second=s.takeRequest()!!
   assertEquals("/cheap",first.path);assertEquals("/quality",second.path)
   assertEquals("Bearer synthetic-low",first.getHeader("Authorization"));assertEquals("Bearer synthetic-high",second.getHeader("Authorization"))
   assertTrue(first.body.readUtf8().contains("economy"));assertTrue(second.body.readUtf8().contains("quality"))
  }
 }
 @Test fun ordinaryConversationUsesCheapForBothStages()=runTest {
  MockWebServer().use {s->s.start();s.enqueue(MockResponse().setBody(envelope(json.encodeToString(d))));s.enqueue(MockResponse().setBody(envelope("""{"alternatives":["好呀","聊聊吧","你呢"]}""")))
   val a=a.copy(messages=listOf(ChatMessage(id="incoming",speaker=Speaker.OTHER,text="今天怎么样")));val c=MobilePipelineV2.build(a,"");val client=ModelClient(allowLocalTestHttp=true)
   client.generateV2(c,client.decideV2(c,"",settings(s)),a,"",settings(s));repeat(2){assertEquals("/cheap",s.takeRequest()!!.path)}
  }
 }
 @Test fun invalidDecisionAndMissingMemoryDoNotReachGeneration()=runTest {
  for(value in listOf(json.encodeToString(d).dropLast(1)+",\"unexpected\":true}",json.encodeToString(d.copy(evidence_message_ids=listOf("forged"))))) {
   MockWebServer().use {s->s.start();s.enqueue(MockResponse().setBody(envelope(value)));assertNotNull(runCatching {ModelClient(allowLocalTestHttp=true).decideV2(c,"",settings(s))}.exceptionOrNull());assertEquals(1,s.requestCount)}
  }
  MockWebServer().use {s->s.start();s.enqueue(MockResponse().setBody(envelope(json.encodeToString(d.copy(required_memory_keys=listOf("birthday"))))));val client=ModelClient(allowLocalTestHttp=true);val result=client.decideV2(c,"",settings(s));assertEquals("ask_user",result.action);assertNotNull(runCatching {client.generateV2(c,result,a,"",settings(s))}.exceptionOrNull());assertEquals(1,s.requestCount)}
 }
 @Test fun highFailureNeverSilentlyRetriesCheapAndQuotaPreventsRequest()=runTest {
  MockWebServer().use {s->s.start();s.enqueue(MockResponse().setResponseCode(503));val client=ModelClient(allowLocalTestHttp=true)
   assertNotNull(runCatching {client.generateV2(c,d.copy(risk_level="high"),a,"",settings(s))}.exceptionOrNull());assertEquals(1,s.requestCount)
   client.reserveV2={_,_->error("budget exhausted")};assertNotNull(runCatching {client.decideV2(c,"",settings(s))}.exceptionOrNull());assertEquals(1,s.requestCount)
  }
 }
 @Test fun screenshotOnlyRecognizesThenRunsDecisionAndGeneration()=runTest {
  val file=File.createTempFile("mobile-v2", ".jpg").apply {writeBytes(byteArrayOf(1,2,3))}
  try {MockWebServer().use {s->s.start();s.enqueue(MockResponse().setBody(envelope("""{"pages":[{"sourceId":"page","messages":[{"speaker":"OTHER","text":"今天怎么样"}]}]}""")));s.enqueue(MockResponse().setBody(envelope(json.encodeToString(d))));s.enqueue(MockResponse().setBody(envelope("""{"alternatives":["好呀","聊聊吧","你呢"]}""")))
   val client=ModelClient(allowLocalTestHttp=true);val settings=settings(s).copy(visionEndpoint=s.url("/vision").toString(),visionModel="vision",visionKey="synthetic-vision")
   val r=client.screenshotReply(a,listOf(ScreenshotPage(id="page",path=file.path,rows=emptyList())),emptyList(),"",settings,recognitionOnly=true)
   assertTrue(r.alternatives.isEmpty());val a=a.copy(messages=r.pages.single().messages.map {ChatMessage(id="incoming",speaker=it.speaker,text=it.text)});val c=MobilePipelineV2.build(a,"")
   client.generateV2(c,client.decideV2(c,"",settings),a,"",settings);assertEquals(3,s.requestCount)
   val vision=s.takeRequest()!!.body.readUtf8();assertTrue(vision.contains("只识别本轮"));assertFalse(vision.contains("不要问地址"));assertEquals("/cheap",s.takeRequest()!!.path);assertEquals("/cheap",s.takeRequest()!!.path)
  }}finally{file.delete()}
 }
}
