package cn.replyassistant.ai

import cn.replyassistant.domain.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.io.File

class ModelClientTest {
    private fun envelope(content: String) = kotlinx.serialization.json.buildJsonObject {
        put("choices", kotlinx.serialization.json.buildJsonArray { add(kotlinx.serialization.json.buildJsonObject {
            put("message", kotlinx.serialization.json.buildJsonObject { put("content", kotlinx.serialization.json.JsonPrimitive(content)) })
        }) })
    }.toString()
    private val archive = ContextEngine.append(ChatArchive(name = "测试对象"), listOf(ChatMessage(speaker = Speaker.OTHER, text = "周末有空吗")))
    @Test fun `real HTTP shape supports bounded chunked responses and required context`() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setChunkedBody(envelope("""{"alternatives":["周日下午可以"],"note":"","uncertain":false}"""), 11))
            server.start()
            val result = ModelClient(allowLocalTestHttp = true).reply(archive, "简短一点", ModelSettings(
                textEndpoint = server.url("/v1/chat/completions").toString(), textKey = "test-secret"))
            assertEquals("周日下午可以", result.alternatives.single())
            val request = server.takeRequest(3, TimeUnit.SECONDS)!!
            assertEquals("Bearer test-secret", request.getHeader("Authorization"))
            val body = request.body.readUtf8()
            assertTrue(body.contains("简短一点")); assertTrue(body.contains("周末有空吗"))
        }
    }
    @Test fun `HTTP failures never leak upstream body or credentials`() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(401).setBody("test-secret chat body")); server.start()
            val error = runCatching { ModelClient(allowLocalTestHttp = true).reply(archive, "", ModelSettings(textEndpoint = server.url("/").toString(), textKey = "test-secret")) }.exceptionOrNull()!!
            assertTrue(error.message!!.contains("401")); assertFalse(error.message!!.contains("test-secret")); assertFalse(error.message!!.contains("chat body"))
        }
    }
    @Test fun `redirects are not followed with authorization`() = runTest {
        MockWebServer().use { server ->
            server.start(); server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", server.url("/other")))
            val error = runCatching { ModelClient(allowLocalTestHttp = true).reply(archive, "", ModelSettings(textEndpoint = server.url("/").toString(), textKey = "key")) }.exceptionOrNull()
            assertNotNull(error); assertEquals(1, server.requestCount)
        }
    }
    @Test fun `empty or malformed alternatives fail instead of fabricating a reply`() = runTest {
        for (content in listOf("不是 JSON", """{"alternatives":[]}""", """{"alternatives":[""]}""")) {
            MockWebServer().use { server ->
                server.enqueue(MockResponse().setBody(envelope(content))); server.start()
                assertNotNull(runCatching { ModelClient(allowLocalTestHttp = true).reply(archive, "", ModelSettings(textEndpoint = server.url("/").toString(), textKey = "key")) }.exceptionOrNull())
            }
        }
    }
    @Test fun `public model endpoint requires HTTPS and cannot contain credentials`() {
        val client = ModelClient()
        for (endpoint in listOf("http://example.com/v1/chat/completions", "https://secret@example.com/v1", "https://example.com/?key=secret")) {
            assertNotNull(runCatching { client.validateEndpoint(endpoint) }.exceptionOrNull())
        }
        client.validateEndpoint("https://api.deepseek.com/v1/chat/completions")
    }
    @Test fun `cancelled generation is not retried`() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(envelope("""{"alternatives":["你好"]}""")).setBodyDelay(3, TimeUnit.SECONDS)); server.start()
            val task = async { ModelClient(allowLocalTestHttp = true).reply(archive, "", ModelSettings(textEndpoint = server.url("/").toString(), textKey = "key")) }
            yield()
            withContext(Dispatchers.IO) { server.takeRequest(3, TimeUnit.SECONDS) }
            task.cancelAndJoin(); assertEquals(1, server.requestCount)
        }
    }
    private fun visualContent(source: String = "page-a", mismatch: Boolean = false, missing: Boolean = false) =
        """{"pages":[{"sourceId":"$source","messages":[{"speaker":"OTHER","text":"这张图怎么样","uncertain":false}],"imageDescription":"一只猫"}],"alternatives":["挺可爱的","这只猫好可爱","看着很乖"],"contactMismatch":$mismatch,"needsMoreContext":$missing}"""
    @Test fun `one multimodal request includes screenshot history style corrections and instruction`() = runTest {
        val file = File.createTempFile("visual-test", ".jpg").apply { writeBytes(byteArrayOf(1, 2, 3)) }
        try { MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(envelope(visualContent()))); server.start()
            val result = ModelClient(allowLocalTestHttp = true).screenshotReply(archive, listOf(ScreenshotPage("page-a", file.path,
                listOf(ChatMessage(speaker = Speaker.OTHER, text = "用户纠正后的文字")), corrected = true)), emptyList(), "委婉一些",
                ModelSettings(visionEndpoint = server.url("/").toString(), visionModel = "synthetic-vision", visionKey = "visual-key", globalStyle = "简单口语"))
            assertEquals(3, result.alternatives.size); assertEquals("一只猫", result.pages.single().imageDescription)
            assertEquals(1, server.requestCount)
            val request = server.takeRequest()!!; val body = request.body.readUtf8()
            assertEquals("Bearer visual-key", request.getHeader("Authorization"))
            for (expected in listOf("data:image/jpeg;base64,AQID", "image_url", "周末有空吗", "委婉一些", "简单口语", "用户纠正后的文字", "page-a")) assertTrue(expected, body.contains(expected))
        } } finally { file.delete() }
    }
    @Test fun `visual result rejects invented source ids and malformed replies`() = runTest {
        val file = File.createTempFile("visual-test", ".jpg").apply { writeBytes(byteArrayOf(1)) }
        try { for (content in listOf(visualContent("invented"), visualContent().replace("\"OTHER\"", "\"invented\""), "不是JSON", visualContent().replace("\"挺可爱的\",", ""))) {
            MockWebServer().use { server ->
                server.enqueue(MockResponse().setBody(envelope(content))); server.start()
                assertNotNull(runCatching { ModelClient(allowLocalTestHttp = true).screenshotReply(archive, listOf(ScreenshotPage("page-a", file.path, emptyList())), emptyList(), "",
                    ModelSettings(visionEndpoint = server.url("/").toString(), visionModel = "model", visionKey = "key")) }.exceptionOrNull())
            }
        } } finally { file.delete() }
    }
    @Test fun `unclear image or different contact never produces actionable replies`() = runTest {
        val file = File.createTempFile("visual-test", ".jpg").apply { writeBytes(byteArrayOf(1)) }
        try { for (content in listOf(visualContent(mismatch = true), visualContent(missing = true))) {
            MockWebServer().use { server ->
                server.enqueue(MockResponse().setBody(envelope(content))); server.start()
                val result = ModelClient(allowLocalTestHttp = true).screenshotReply(archive, listOf(ScreenshotPage("page-a", file.path, emptyList())), emptyList(), "",
                    ModelSettings(visionEndpoint = server.url("/").toString(), visionModel = "model", visionKey = "key"))
                assertTrue(result.alternatives.isEmpty())
            }
        } } finally { file.delete() }
    }
    @Test fun `missing vision configuration does not fall back to text model`() = runTest {
        val error = runCatching { ModelClient().screenshotReply(archive, emptyList(), emptyList(), "", ModelSettings(textKey = "text-key")) }.exceptionOrNull()!!
        assertTrue(error.message!!.contains("多模态"))
    }
    @Test fun `compatible base addresses expand once without changing the destination host`() {
        val model = ModelClient()
        assertEquals("https://api.deepseek.com/chat/completions", model.resolvedEndpoint("https://api.deepseek.com"))
        assertEquals("https://api.deepseek.com/v1/chat/completions", model.resolvedEndpoint("https://api.deepseek.com/v1/"))
        assertEquals("https://api.deepseek.com/chat/completions", model.resolvedEndpoint("https://api.deepseek.com/chat/completions"))
        assertEquals("https://example.com/compatible-mode/v1/chat/completions", model.resolvedEndpoint("https://example.com/compatible-mode/v1/chat/completions"))
        assertNotNull(runCatching { model.resolvedEndpoint("https://key@example.com") }.exceptionOrNull())
    }
    @Test fun `base address sends one request to the complete operation path`() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(envelope("""{"alternatives":["好的"]}"""))); server.start()
            ModelClient(allowLocalTestHttp = true).reply(archive, "", ModelSettings(textEndpoint = server.url("/v1").toString(), textKey = "key"))
            assertEquals("/v1/chat/completions", server.takeRequest().path)
            assertEquals(1, server.requestCount)
        }
    }

    @Test fun `consultation without new pictures explicitly forbids historical screenshot pages`() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(envelope("""{"pages":[],"advisor":{"summary":"先自然接话","unknowns":["关系背景未知"]},"alternatives":["可以呀"]}"""))); server.start()
            val context = archive.copy(skill = SkillConfig(enabled = true),consultation = Consultation(question = "怎么回",background = "合成背景"))
            val result = ModelClient(allowLocalTestHttp = true).consult(context,"question-id",ModelSettings(visionEndpoint = server.url("/").toString(),visionKey = "synthetic",visionModel = "test"),"狗头军师测试资料")
            assertNotNull(result.advisor); assertTrue(result.pages.isEmpty())
            val body = server.takeRequest()!!.body.readUtf8()
            assertTrue(body.contains("没有本轮图片时pages必须为空数组"))
            assertTrue(body.contains("本轮图片来源ID列表=[]")); assertTrue(body.contains("question-id"))
            assertEquals(1,server.requestCount)
        }
    }
    @Test fun `consultation rejects invented picture sources without retry`() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(envelope("""{"pages":[{"sourceId":"old-picture","messages":[]}],"advisor":{"summary":"建议"},"alternatives":[]}"""))); server.start()
            val error = runCatching { ModelClient(allowLocalTestHttp = true).consult(archive.copy(consultation = Consultation(question = "怎么回")),"question-id",ModelSettings(visionEndpoint = server.url("/").toString(),visionKey = "synthetic",visionModel = "test"),"狗头军师") }.exceptionOrNull()
            assertTrue(error!!.message!!.contains("不属于本轮")); assertEquals(1,server.requestCount)
        }
    }

    @Test fun `fast options are restricted to supported official models and preserve generic APIs`() {
        val model = ModelClient()
        val messages = kotlinx.serialization.json.buildJsonArray { }
        val official = model.requestPayload("https://api.deepseek.com","deepseek-flash",messages,6000,true).toString()
        assertTrue(official.contains("disabled"))
        for ((endpoint,name,fast) in listOf(Triple("https://proxy.example.com","deepseek-flash",true),
            Triple("https://api.deepseek.com.evil.test","deepseek-flash",true),Triple("https://api.deepseek.com","unknown-model",true),
            Triple("https://api.deepseek.com","deepseek-flash",false)))
            assertFalse(model.requestPayload(endpoint,name,messages,6000,fast).containsKey("thinking"))
    }
    @Test fun `rewriting current pictures does not duplicate their previous recognition in history`() = runTest {
        val file = File.createTempFile("visual-test", ".jpg").apply { writeBytes(byteArrayOf(1)) }
        try { MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(envelope(visualContent())));server.start()
            val current = ChatMessage(speaker = Speaker.OTHER,text = "旧识别只在图片里出现",sourceId = "page-a",origin = Origin.SCREENSHOT)
            ModelClient(allowLocalTestHttp = true).screenshotReply(archive.copy(messages = archive.messages + current),listOf(ScreenshotPage("page-a",file.path,listOf(current))),emptyList(),"",ModelSettings(visionEndpoint = server.url("/").toString(),visionModel = "synthetic",visionKey = "key"))
            val body = server.takeRequest()!!.body.readUtf8()
            assertFalse(body.contains("旧识别只在图片里出现"));assertTrue(body.contains("image_url"));assertTrue(body.contains("周末有空吗"))
        } } finally { file.delete() }
    }
}
