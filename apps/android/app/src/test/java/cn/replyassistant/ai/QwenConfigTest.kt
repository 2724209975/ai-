package cn.replyassistant.ai
import cn.replyassistant.domain.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class QwenConfigTest {
 @Test fun `preset clears foreign secrets and retains device settings and budget`() {
  val original=ModelSettings(textKey="foreign-private-key",visionEndpoint="https://untrusted.invalid/v1/",visionKey="foreign-vision",qualityKey="foreign-quality",dailyCallLimit=9,dailyCnyLimit=0.1,globalStyle="my style")
  val preset=QwenPreset.apply(original);assertEquals("",preset.textKey);assertEquals("",preset.visionKey);assertEquals("",preset.qualityKey);assertEquals(9,preset.dailyCallLimit);assertEquals(0.1,preset.dailyCnyLimit,0.0);assertEquals("my style",preset.globalStyle)
  val reused=QwenPreset.reuseTextKey(preset.copy(textKey="synthetic-qwen-key"));assertEquals(reused.textKey,reused.visionKey);assertEquals(reused.textKey,reused.qualityKey)
  assertTrue(runCatching {QwenPreset.reuseTextKey(reused.copy(qualityEndpoint="https://foreign.invalid/"))}.isFailure)
 }
 @Test fun `qwen base expands once and supported official models disable reasoning`() {
  val client=ModelClient();val messages=buildJsonArray{}
  assertEquals(QwenPreset.endpoint+"chat/completions",client.resolvedEndpoint(QwenPreset.endpoint))
  val request=client.requestPayload(QwenPreset.endpoint,"qwen3.7-flash",messages,1024,true);assertEquals(false,request["enable_thinking"]?.jsonPrimitive?.boolean);assertFalse(request.containsKey("thinking"))
  for((url,model,fast) in listOf(Triple("https://dashscope.aliyuncs.com.evil.invalid/v1/","qwen3.7-flash",true),Triple(QwenPreset.endpoint,"other-model",true),Triple(QwenPreset.endpoint,"qwen3.7-flash",false))) assertFalse(client.requestPayload(url,model,messages,1024,fast).containsKey("enable_thinking"))
  assertEquals(false,client.requestPayload("https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/","qwen3.5-plus",messages,1024,true)["enable_thinking"]?.jsonPrimitive?.boolean)
 }
}
