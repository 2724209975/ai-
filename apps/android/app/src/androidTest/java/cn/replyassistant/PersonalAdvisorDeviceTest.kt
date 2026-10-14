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
class PersonalAdvisorDeviceTest {
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
    @Test fun newCaptureBatchRetainsUnprocessedFilesDraftAndOriginAcrossRestart() {
        val namespace = "synthetic-batches-${newId()}"
        val controller = AssistantController(context,storageNamespace = namespace)
        val first = page(); val second = page(); val third = page()
        try {
            main {
                val id = controller.createArchive("SyntheticBatch","测试")
                controller.mutateArchive(id) { it.copy(draft = ReplyDraft(contextRevision = 0,alternatives = listOf("手工旧稿"),manuallyEdited = true)) }
                controller.addCapturedPage(first,append = false)
                controller.addCapturedPage(second,append = false)
                assertEquals(listOf(second.id),controller.state.value.preview!!.pages.map { it.id })
                assertEquals(first.id,controller.state.value.preview!!.heldBatches.single().pages.single().id)
                assertEquals("手工旧稿",controller.selected()!!.draft!!.text)
                controller.addCapturedPage(third,append = true)
                assertEquals(2,controller.state.value.preview!!.pages.size)
            }
            val restored = AssistantController(context,storageNamespace = namespace)
            try {
                main {
                    assertTrue(File(first.path).exists())
                    val held = restored.state.value.preview!!.heldBatches.single()
                    restored.restoreCaptureBatch(held.id)
                    assertEquals(first.id,restored.state.value.preview!!.pages.single().id)
                    assertEquals(2,restored.state.value.preview!!.heldBatches.single().pages.size)
                    assertEquals("手工旧稿",restored.selected()!!.draft!!.text)
                    val id = restored.selected()!!.id
                    restored.restoreCaptureBatch(restored.state.value.preview!!.heldBatches.single().id)
                    restored.updatePreview { it.copy(pages = it.pages.mapIndexed { index,p -> if (index == 0) p.copy(includeVisual = true) else p }) }
                    val other = restored.createArchive("SyntheticOtherBatch","测试")
                    assertTrue(restored.state.value.preview!!.pages.isEmpty())
                    assertTrue(restored.state.value.preview!!.heldBatches.all { it.archiveId == id })
                    assertTrue(File(second.path).exists()); assertTrue(File(third.path).exists())
                    restored.deleteArchive(id)
                    restored.deleteArchive(other)
                    assertFalse(File(first.path).exists()); assertFalse(File(second.path).exists()); assertFalse(File(third.path).exists())
                }
            } finally { restored.scope.cancel() }
        } finally { controller.scope.cancel(); listOf(first,second,third).forEach { File(it.path).delete() } }
    }
    @Test fun freshCaptureRetainsCandidatesUntilReplacementAndPreservesProtectedDrafts() {
        val controller = AssistantController(context,storageNamespace = "synthetic-discard-${newId()}")
        val images = listOf(page(),page(),page(),page())
        try { main {
            val id = controller.createArchive("SyntheticDiscard","测试")
            controller.mutateArchive(id) { it.copy(draft = ReplyDraft(contextRevision = 0,alternatives = listOf("旧自动候选"))) }
            controller.addCapturedPage(images[0],append = false)
            assertEquals("旧自动候选",controller.selected()!!.draft!!.text)
            assertTrue(controller.selected()!!.draftHistory.isEmpty())
            controller.mutateArchive(id) { it.copy(draft = ReplyDraft(contextRevision = 0,alternatives = listOf("已复制稿"),state = DraftState.COPIED)) }
            controller.addCapturedPage(images[1],append = false)
            assertEquals("已复制稿",controller.selected()!!.draft!!.text)
            controller.mutateArchive(id) { it.copy(draft = ReplyDraft(contextRevision = 0,alternatives = listOf("手工稿"),manuallyEdited = true)) }
            controller.addCapturedPage(images[2],append = false)
            assertEquals("手工稿",controller.selected()!!.draft!!.text)
            controller.mutateArchive(id) { it.copy(draft = ReplyDraft(contextRevision = 0,alternatives = listOf("本轮候选"))) }
            controller.addCapturedPage(images[3],append = true)
            assertEquals("本轮候选",controller.selected()!!.draft!!.text)
        } } finally { controller.scope.cancel(); images.forEach { File(it.path).delete() } }
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
            contactMismatch = mismatch, needsMoreContext = missing, advisor = AdvisorAnalysis(summary = "先接话，保持自然",facts = listOf("对方邀约"),actions = listOf("确认时间")), memorySuggestions = pages.map { MemorySuggestion("fact","对方约喝咖啡",listOf(it.id)) }))
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


    @Test fun bundledSkillScreenshotFeedbackDraftRecoveryAndExplicitPreference() {
        val (server,model) = server()
        server.use {
            val controller = setup(server,model); val page = page()
            try {
                val id = controller.selected()!!.id
                main { controller.setSkill(id,true); controller.changeMemory(id,"enable") }
                server.enqueue(response(listOf(page)))
                main { controller.addCapturedPage(page) }; idle(controller)
                assertTrue(controller.state.value.error,controller.state.value.error.isBlank())
                val recognition = server.takeRequest()!!.body.readUtf8()
                assertTrue(recognition.contains("image_url"));server.takeRequest()
                val body=server.takeRequest()!!.body.readUtf8()
                assertTrue(body.contains("狗头军师"))
                assertEquals(3,server.requestCount)
                assertNotNull(controller.selected()!!.draft!!.advisor)
                assertEquals(1,controller.selected()!!.memory.entries.size)
                assertTrue(Personalization.samples(controller.selected()!!).isEmpty())
                main { controller.teachSample(controller.selected()!!.messages.first { it.speaker == Speaker.ME }.id,true) }
                server.enqueue(response(listOf(page)))
                main { controller.generate("沿用样例") }; idle(controller)
                repeat(2){server.takeRequest()}
                assertEquals(1,Personalization.samples(controller.selected()!!).size)
                main { controller.editDraft("手工改过的回复") }
                server.enqueue(response(listOf(page)))
                main { controller.feedback("太长了") }; idle(controller)
                val rewriteRequest=server.takeRequest()!!.body.readUtf8()
                assertTrue(rewriteRequest.contains("更简短"))
                assertTrue(rewriteRequest.contains("手工改过的回复") && rewriteRequest.contains("尚未发送"))
                assertTrue(controller.selected()!!.preferences.isEmpty())
                assertEquals("手工改过的回复",controller.selected()!!.draftHistory.single().text)
                main { controller.savePreference("不使用感叹号",false) }
                assertEquals("不使用感叹号",controller.selected()!!.preferences.single().text)
                main { controller.restoreDraft(controller.selected()!!.draftHistory.single().id) }
                assertEquals("手工改过的回复",controller.selected()!!.draft!!.text)
                assertTrue(controller.selected()!!.draft!!.manuallyEdited)
                main { controller.changeMemory(id,"undo") }
            } finally { finish(controller) }
        }
    }
    @Test fun consultationPersistsIsolatedAndTransfersOnlyDraft() {
        val (server,model) = server()
        server.use {
            val namespace = "synthetic-${newId()}"
            val controller = setup(server,model,namespace)
            lateinit var restored: AssistantController
            try {
                val id = controller.selected()!!.id
                main { controller.setSkill(id,true); controller.openAdvisor(id); controller.editConsultation(id,"怎么推进？","认识两周") }
                server.enqueue(response(emptyList()))
                main { controller.consult(id) }; idle(controller)
                assertTrue(controller.state.value.error,controller.state.value.error.isBlank())
                assertTrue(server.takeRequest()!!.body.readUtf8().contains("怎么推进"))
                assertEquals(1,controller.selected()!!.consultation.turns.size)
                assertTrue(controller.selected()!!.messages.isEmpty()); assertNull(controller.selected()!!.draft)
                main { restored = AssistantController(context,model,namespace) }
                assertEquals(1,restored.selected()!!.consultation.turns.size)
                main { controller.closeAdvisor(); controller.createArchive("另一个对象","测试") }
                assertTrue(controller.selected()!!.consultation.turns.isEmpty()); assertFalse(controller.selected()!!.skill.enabled)
                main { controller.openAdvisor(id); controller.useConsultReply(id,restored.selected()!!.consultation.turns.single().id,0) }
                assertEquals(id,controller.selected()!!.id)
                assertTrue(controller.selected()!!.messages.isEmpty()); assertEquals(DraftState.EDITING,controller.selected()!!.draft!!.state)
                main { controller.copyDraft() }
                assertTrue(controller.selected()!!.messages.isEmpty())
                main { controller.deleteConsultation(id); restored.scope.cancel() }
                assertTrue(controller.selected()!!.consultation.turns.isEmpty())
            } finally { finish(controller) }
        }
    }
    @Test fun settingsChangeDuringConsultationRejectsResultAndFailureRetainsInputImages() {
        val (server,model) = server()
        server.use {
            val controller = setup(server,model); val image = page()
            try {
                val id = controller.selected()!!.id
                main {
                    controller.setSkill(id,true); controller.openAdvisor(id); controller.editConsultation(id,"看这张图怎么回","背景")
                    controller.mutateArchive(id) { it.copy(consultation = it.consultation.copy(pages = listOf(image))) }
                }
                server.enqueue(response(listOf(image),delay = 600))
                main { controller.consult(id) }
                server.takeRequest(5,TimeUnit.SECONDS)
                main { controller.saveSettings(controller.state.value.settings.copy(globalStyle = "新偏好")) }; idle(controller)
                assertTrue(controller.state.value.error.contains("改变"))
                assertTrue(controller.selected()!!.consultation.turns.isEmpty())
                assertTrue(File(image.path).exists()); assertEquals("看这张图怎么回",controller.selected()!!.consultation.question)
                server.enqueue(MockResponse().setResponseCode(500))
                main { controller.consult(id) }; idle(controller)
                assertTrue(File(image.path).exists()); assertTrue(controller.state.value.error.contains("500"))
                server.enqueue(response(listOf(image)))
                main { controller.consult(id) }; idle(controller)
                assertTrue(controller.state.value.error,controller.state.value.error.isBlank())
                assertFalse(File(image.path).exists()); assertEquals(1,controller.selected()!!.consultation.turns.size)
                assertTrue(controller.selected()!!.messages.isEmpty())
            } finally { finish(controller) }
        }
    }

    @Test fun opacityPersistsAndChangingItDuringModelRequestDoesNotDiscardReply() {
        val (server,model) = server()
        server.use {
            val namespace = "synthetic-${newId()}"
            val controller = setup(server,model,namespace);val image = page()
            try {
                server.enqueue(response(listOf(image),delay = 500))
                main { controller.addCapturedPage(image) }
                server.takeRequest(5,TimeUnit.SECONDS)
                main { controller.previewOverlayOpacity(.4f,.6f);controller.saveOverlayOpacity() };idle(controller)
                assertTrue(controller.state.value.error,controller.state.value.error.isBlank())
                assertNotNull(controller.selected()!!.draft)
                lateinit var restored: AssistantController
                main { restored = AssistantController(context,model,namespace) }
                assertEquals(.4f,restored.state.value.settings.bubbleOpacity)
                assertEquals(.6f,restored.state.value.settings.panelOpacity)
                main { restored.scope.cancel() }
            } finally { finish(controller) }
        }
    }
}
