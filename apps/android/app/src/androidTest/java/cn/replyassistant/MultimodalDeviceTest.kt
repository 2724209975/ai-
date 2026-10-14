package cn.replyassistant

import android.graphics.Bitmap
import android.os.SystemClock
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import cn.replyassistant.ai.*
import cn.replyassistant.data.AssistantController
import cn.replyassistant.domain.*
import cn.replyassistant.platform.ImageImporter
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.TimeUnit

/** Only synthetic screenshots and local TLS responses; never user's model or chats. */
@RunWith(AndroidJUnit4::class)
class MultimodalDeviceTest {
    @Test fun cancellingVisualGenerationRetainsSourcesAndManualDraftAndRetryUsesTheEdit() {
        val (server, model) = server()
        server.use {
            val controller = setup(server, model)
            val source = page()
            try {
                main { controller.mutateArchive(controller.selected()!!.id) {
                    it.copy(draft = ReplyDraft(contextRevision = it.revision, alternatives = listOf("原建议"), text = "本人改过的回复", manuallyEdited = true))
                } }
                server.enqueue(response(listOf(source), delay = 2000))
                // A manual draft prevents automatic generation; the explicit request is cancellable.
                main { controller.addCapturedPage(source)
                    controller.mutateArchive(controller.selected()!!.id) { it.copy(draft = it.draft!!.copy(previewVersion = controller.state.value.preview!!.version)) }
                    controller.generate("简短一点") }
                assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
                main { controller.cancelGeneration() }
                assertFalse(controller.state.value.busy)
                assertTrue(controller.state.value.generationCancelled)
                assertEquals("本人改过的回复", controller.selected()!!.draft!!.text)
                assertEquals(source.id, controller.state.value.preview!!.pages.single().id)
                assertTrue(File(source.path).exists())
                assertTrue(controller.selected()!!.messages.isEmpty())
                server.enqueue(response(listOf(source)))
                main { controller.generate("简短一点") }
                val request = server.takeRequest(5, TimeUnit.SECONDS)!!.body.readUtf8()
                idle(controller)
                assertFalse(request.contains("本人改过的回复"))
                server.takeRequest()
                assertTrue(server.takeRequest()!!.body.readUtf8().contains("本人改过的回复"))
                assertFalse(controller.state.value.generationCancelled)
                assertTrue(controller.state.value.error.isBlank())
                assertEquals(4, server.requestCount)
                assertEquals(3, controller.selected()!!.draft!!.alternatives.size)
            } finally { finish(controller) }
        }
    }
    @Test fun accessibleLayoutGeneratesOnceDeduplicatesAndKeepsOldReplyUntilReplacement() {
        val (server,model)=server()
        server.use {
            val controller=setup(server,model)
            val first=ScreenshotPage(path="",rows=emptyList(),accessibleText="合成界面：对方问周末有空吗；我说周日下午吧；对方说一起喝咖啡")
            try {
                server.enqueue(response(listOf(first)))
                main {controller.addCapturedPage(first,append=false)};idle(controller)
                val request=server.takeRequest()!!.body.readUtf8()
                assertTrue(request.contains("合成界面"));assertFalse(request.contains("data:image"))
                assertTrue(controller.selected()!!.messages.all {it.origin==Origin.ACCESSIBILITY})
                val old=controller.selected()!!.draft!!
                val ids=controller.selected()!!.messages.map {it.id}
                val second=first.copy(id=newId())
                server.enqueue(MockResponse().setResponseCode(503))
                main {controller.addCapturedPage(second,append=false)};idle(controller)
                assertEquals(old,controller.selected()!!.draft)
                assertEquals(second.id,controller.state.value.preview!!.pages.single().id)
                server.enqueue(response(listOf(second)))
                main {controller.generate("自然一点")};idle(controller)
                assertEquals(ids,controller.selected()!!.messages.map {it.id})
                assertTrue(controller.state.value.captureStatus.contains("已保存"))
                assertNotEquals(old.id,controller.selected()!!.draft!!.id)
                assertTrue(controller.selected()!!.draftHistory.isEmpty())
            } finally {finish(controller)}
        }
    }
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun main(block: () -> Unit) = instrumentation.runOnMainSync(block)
    private fun idle(controller: AssistantController) {
        val deadline = SystemClock.uptimeMillis() + 15_000
        while (controller.state.value.busy && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(50)
        assertFalse("Generation must finish", controller.state.value.busy)
    }
    private fun page(): ScreenshotPage = runBlocking {
        val bitmap = Bitmap.createBitmap(400, 600, Bitmap.Config.ARGB_8888)
        try { ImageImporter(context).fromBitmap(bitmap) } finally { bitmap.recycle() }
    }
    private fun server(): Pair<MockWebServer, ModelClient> {
        val cert = HeldCertificate.Builder().commonName("localhost").addSubjectAlternativeName("localhost").build()
        val serverCerts = HandshakeCertificates.Builder().heldCertificate(cert).build()
        val clientCerts = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val server = MockWebServer().apply { dispatcher=IndependentPipelineDispatcher(); useHttps(serverCerts.sslSocketFactory(), false); start() }
        val model = ModelClient(OkHttpClient.Builder().sslSocketFactory(clientCerts.sslSocketFactory(), clientCerts.trustManager)
            .followRedirects(false).retryOnConnectionFailure(false).build())
        return server to model
    }
    private fun response(pages: List<ScreenshotPage>, mismatch: Boolean = false, missing: Boolean = false, delay: Long = 0): MockResponse {
        val content = Json.encodeToString(ScreenshotReply(pages.map { p -> VisualPage(p.id, listOf(
            VisualMessage(Speaker.OTHER, "周末有空吗"), VisualMessage(Speaker.ME, "周日下午吧"),
            VisualMessage(Speaker.OTHER, "一起喝咖啡")), "") }, listOf("可以呀", "周日下午可以", "好呀，一起去"),
            contactMismatch = mismatch, needsMoreContext = missing))
        return MockResponse().setBody(buildJsonObject { put("choices", buildJsonArray { add(buildJsonObject {
            put("message", buildJsonObject { put("content", content) })
        }) }) }.toString()).setBodyDelay(delay, TimeUnit.MILLISECONDS)
    }
    private fun setup(server: MockWebServer, model: ModelClient, namespace: String = "synthetic-${newId()}"): AssistantController {
        lateinit var controller: AssistantController
        val endpoint = server.url("/chat/completions").toString()
        main {
            controller = AssistantController(context, model, namespace)
            controller.createArchive("截图对象", "第三方软件")
            controller.saveSettings(ModelSettings(visionEndpoint = endpoint, visionModel = "synthetic-vision",
                visionKey = "synthetic-vision-key", screenshotUploadAccepted = true))
        }
        return controller
    }
    private fun finish(controller: AssistantController) { main { controller.closePreview(); controller.scope.cancel() } }

    @Test fun firstChosenContactAutomaticallyGeneratesWithImageAndSurvivesRestart() {
        val (server, model) = server()
        server.use {
            val namespace = "synthetic-${newId()}"
            val controller = setup(server, model, namespace); val page = page()
            try {
                assertTrue(page.rows.isEmpty())
                server.enqueue(response(listOf(page)))
                main { controller.addCapturedPage(page) }; idle(controller)
                assertEquals(3, server.requestCount)
                assertTrue(server.takeRequest()!!.body.readUtf8().contains("data:image/jpeg;base64,"))
                val archive = controller.selected()!!
                assertEquals(3, archive.draft!!.alternatives.size); assertEquals(3, archive.messages.size)
                assertTrue(File(page.path).exists())
                main { controller.copyDraft() }
                assertEquals(3, controller.selected()!!.messages.size)
                lateinit var restored: AssistantController
                main { restored = AssistantController(context, model, namespace) }
                assertEquals(archive.id, restored.selected()!!.id)
                assertEquals(DraftState.COPIED, restored.selected()!!.draft!!.state)
                main { controller.closePreview() }
                assertFalse(File(page.path).exists())
                assertEquals(3, controller.selected()!!.messages.size)
                main { restored.scope.cancel() }
            } finally { finish(controller) }
        }
    }
    @Test fun repeatedScreenshotWithPictureNotesDoesNotDuplicateAndEarlierContextPrepends() {
        val (server,model)=server();val controller=setup(server,model)
        val dialogue=listOf(VisualMessage(Speaker.OTHER,"周末一起去喝咖啡吗"),VisualMessage(Speaker.ME,"我周日下午可以"),VisualMessage(Speaker.OTHER,"那我们两点见"))
        fun reply(p:ScreenshotPage,messages:List<VisualMessage>):MockResponse {
            val content=Json.encodeToString(ScreenshotReply(listOf(VisualPage(p.id,messages,"一张看不清的图片")),listOf("合成回复一","合成回复二","合成回复三")))
            return MockResponse().setBody(buildJsonObject {put("choices",buildJsonArray {add(buildJsonObject {put("message",buildJsonObject {put("content",content)})})})}.toString())
        }
        try {
            val first=page();server.enqueue(reply(first,dialogue));main {controller.addCapturedPage(first,append=false)};idle(controller)
            val ids=controller.selected()!!.messages.map {it.id}
            assertEquals(4,ids.size)
            val repeated=page();server.enqueue(reply(repeated,dialogue));main {controller.addCapturedPage(repeated,append=false)};idle(controller)
            assertEquals(ids,controller.selected()!!.messages.map {it.id})
            val older=page();server.enqueue(reply(older,listOf(VisualMessage(Speaker.ME,"前一天讨论过的背景"))+dialogue));main {controller.addCapturedPage(older,append=false)};idle(controller)
            val merged=controller.selected()!!.messages
            assertEquals(5,merged.size);assertEquals("前一天讨论过的背景",merged.first().text)
            assertEquals(ids,merged.drop(1).map {it.id})
            assertEquals(9,server.requestCount)
        }finally {finish(controller);server.shutdown()}
    }
    @Test fun uploadRequiresOneTimeConsentAndNoVisionConfigurationNeverFallsBack() {
        val (server, model) = server()
        server.use {
            lateinit var controller: AssistantController
            main { controller = AssistantController(context, model, "synthetic-${newId()}"); controller.createArchive("对象", "测试") }
            val page = page()
            try {
                main { controller.addCapturedPage(page) }; idle(controller)
                assertEquals(0, server.requestCount); assertNull(controller.selected()!!.draft)
                main { controller.acceptScreenshotUpload() }; idle(controller)
                assertTrue(controller.state.value.error.contains("多模态"))
                assertTrue(File(page.path).exists()); assertTrue(controller.selected()!!.messages.isEmpty())
            } finally { finish(controller) }
        }
    }
    @Test fun newScreenshotProtectsManualDraftAndExplicitFailureKeepsImagesAndDraft() {
        val (server, model) = server()
        server.use {
            val controller = setup(server, model); val first = page(); val second = page()
            try {
                server.enqueue(response(listOf(first)))
                main { controller.addCapturedPage(first) }; idle(controller)
                main { controller.editDraft("本人手工草稿"); controller.addCapturedPage(second) }; idle(controller)
                assertEquals(3, server.requestCount); assertEquals("本人手工草稿", controller.selected()!!.draft!!.text)
                main { assertTrue(runCatching { controller.copyDraft() }.isFailure) }
                server.enqueue(MockResponse().setResponseCode(400))
                main { controller.generate("简短一点") }; idle(controller)
                assertEquals("本人手工草稿", controller.selected()!!.draft!!.text)
                assertTrue(File(first.path).exists() && File(second.path).exists())
                assertTrue(controller.state.value.error.contains("400"))
            } finally { finish(controller) }
        }
    }
    @Test fun correctionsAndRepeatedGenerationDoNotDuplicateStoredScreenshotMessages() {
        val (server, model) = server()
        server.use {
            val controller = setup(server, model); val page = page()
            try {
                server.enqueue(response(listOf(page)))
                main { controller.addCapturedPage(page) }; idle(controller)
                repeat(3){server.takeRequest()}
                main { controller.updatePreview { p -> p.copy(pages = p.pages.map { old -> old.copy(corrected = true,
                    rows = old.rows.mapIndexed { index, row -> if (index == 0) row.copy(text = "周六有空吗") else row }) }) } }
                server.enqueue(response(listOf(page)))
                main { controller.generate("委婉一些") }; idle(controller)
                val body = server.takeRequest()!!.body.readUtf8()
                assertTrue(body.contains("周六有空吗") && body.contains("委婉一些"))
                assertEquals(3, controller.selected()!!.messages.size)
                assertEquals("周六有空吗", controller.selected()!!.messages.first().text)
                assertEquals(3, controller.selected()!!.draft!!.alternatives.size)
            } finally { finish(controller) }
        }
    }
    @Test fun differentContactOrMissingContentDoesNotSaveIntoChosenArchive() {
        val (server, model) = server()
        server.use {
            val controller = setup(server, model); val page = page()
            try {
                server.enqueue(response(listOf(page), mismatch = true))
                main { controller.addCapturedPage(page) }; idle(controller)
                assertTrue(controller.selected()!!.messages.isEmpty()); assertNull(controller.selected()!!.draft)
                assertTrue(controller.state.value.error.contains("对象"))
                server.enqueue(response(listOf(page), missing = true))
                main { controller.generate("") }; idle(controller)
                assertTrue(controller.selected()!!.messages.isEmpty()); assertTrue(File(page.path).exists())
            } finally { finish(controller) }
        }
    }
    @Test fun inboundDuringVisualRequestRejectsResultAndRetainsPreviousDraft() {
        val (server, model) = server()
        server.use {
            val controller = setup(server, model); val page = page(); val id = controller.selected()!!.id
            try {
                main { controller.mutateArchive(id) { it.copy(draft = ReplyDraft(contextRevision = it.revision, alternatives = listOf("旧草稿"))) } }
                server.enqueue(response(listOf(page), delay = 700))
                main { controller.addCapturedPage(page) }
                assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
                main { controller.mutateArchive(id) { ContextEngine.append(it, listOf(ChatMessage(speaker = Speaker.OTHER, text = "刚来的新消息"))) } }
                idle(controller)
                assertEquals("旧草稿", controller.selected()!!.draft!!.text)
                assertEquals("刚来的新消息", controller.selected()!!.messages.single().text)
                assertTrue(controller.state.value.error.contains("新消息"))
            } finally { finish(controller) }
        }
    }
    @Test fun typingWhileVisualRequestIsRunningDoesNotGetOverwritten() {
        val (server, model) = server()
        server.use {
            val controller = setup(server, model); val page = page(); val id = controller.selected()!!.id
            try {
                main { controller.mutateArchive(id) { it.copy(draft = ReplyDraft(contextRevision = it.revision, alternatives = listOf("旧草稿"))) } }
                server.enqueue(response(listOf(page), delay = 700))
                main { controller.addCapturedPage(page) }
                assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
                main { controller.editDraft("正在输入的草稿") }; idle(controller)
                assertEquals("正在输入的草稿", controller.selected()!!.draft!!.text)
                assertTrue(controller.selected()!!.messages.isEmpty())
            } finally { finish(controller) }
        }
    }
    @Test fun switchingChosenContactKeepsOwnProcessedImagesWithoutRegeneratingOrMixing() {
        val (server, model) = server()
        server.use {
            val controller = setup(server, model); val page = page()
            try {
                server.enqueue(response(listOf(page)))
                main { controller.addCapturedPage(page) }; idle(controller)
                val first = controller.selected()!!.id
                main { controller.createArchive("另一对象", "测试") }; idle(controller)
                assertEquals(3, server.requestCount)
                assertTrue(controller.selected()!!.messages.isEmpty())
                assertTrue(controller.state.value.preview!!.pages.isEmpty())
                assertTrue(File(page.path).exists())
                assertEquals(3, controller.state.value.archives.find { it.id == first }!!.messages.size)
                main {controller.selectArchive(first)}
                assertEquals(page.id,controller.state.value.preview!!.pages.single().id)
                assertTrue(controller.draftIsCurrent())
                assertEquals(3,server.requestCount)
            } finally { finish(controller) }
        }
    }
    @Test fun editingHistoryPropagatesToRetainedImageCorrectionAndRewrite() {
        val (server, model) = server()
        server.use {
            val controller = setup(server, model); val page = page()
            try {
                server.enqueue(response(listOf(page)))
                main { controller.addCapturedPage(page) }; idle(controller); repeat(3){server.takeRequest()}
                val archive = controller.selected()!!
                main { controller.reviseMessages(archive.id, archive.messages.dropLast(1).map { it.copy(text = "纠正的原文${it.speaker}") }) }
                assertEquals(2, controller.state.value.preview!!.pages.single().rows.size)
                server.enqueue(response(listOf(page)))
                main { controller.generate("") }; idle(controller)
                val body = server.takeRequest()!!.body.readUtf8()
                assertTrue(body.contains("纠正的原文"))
                assertEquals(2, controller.selected()!!.messages.size)
                assertFalse(controller.selected()!!.messages.any { it.text == "一起喝咖啡" })
            } finally { finish(controller) }
        }
    }
    @Test fun newerCaptureCancelsOldVisualRequestAndOnlyLatestPagesAreCommitted() {
        val (server, model) = server()
        server.use {
            val controller = setup(server, model); val first = page(); val second = page()
            try {
                server.enqueue(response(listOf(first), delay = 1200))
                main { controller.addCapturedPage(first) }
                assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
                server.enqueue(response(listOf(first, second)))
                main { controller.addCapturedPage(second) }; idle(controller)
                assertEquals(4, server.requestCount)
                assertEquals(2, controller.state.value.preview!!.pages.size)
                assertEquals(3, controller.selected()!!.messages.size)
                assertEquals(controller.state.value.preview!!.version, controller.selected()!!.draft!!.previewVersion)
            } finally { finish(controller) }
        }
    }
    @Test fun importedImagesGenerateAutomaticallyAsOneOrderedMultimodalRequest() {
        val (server, model) = server()
        server.use {
            val controller = setup(server, model); val first = page(); val second = page()
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val body=request.body.readUtf8()
                    if(body.contains("严格包含以下13个字段")) {
                        val content=Json.parseToJsonElement(body).jsonObject["messages"]!!.jsonArray.last().jsonObject["content"]!!.jsonPrimitive.content
                        val ids=Regex("\\[([^\\]\\n]+)\\] 对方：").findAll(content).map {it.groupValues[1]}.toList()
                        val d=MobileDecisionV2("2.0","reply","接话",MobileEmotionV2("neutral",.9),null,"接话","自然","short","low",emptyList(),ids,"NORMAL_REPLY",true)
                        return MockResponse().setBody(buildJsonObject {put("choices",buildJsonArray {add(buildJsonObject {put("message",buildJsonObject {put("content",Json.encodeToString(d))})})})}.toString())
                    }
                    val ids = Regex("sourceId=([a-zA-Z0-9-]+)").findAll(body).map { it.groupValues[1] }.toList()
                    return response(ids.map { ScreenshotPage(it, "unused", emptyList()) })
                }
            }
            try {
                main { controller.importImages(listOf(Uri.fromFile(File(first.path)), Uri.fromFile(File(second.path)))) }
                assertNotNull(server.takeRequest(10, TimeUnit.SECONDS)); idle(controller)
                assertEquals(3, server.requestCount)
                assertEquals(2, controller.state.value.preview!!.pages.size)
                assertEquals(3, controller.selected()!!.draft!!.alternatives.size)
            } finally { finish(controller); File(first.path).delete(); File(second.path).delete() }
        }
    }
}
