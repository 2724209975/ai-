package cn.replyassistant

import android.app.PendingIntent
import android.app.RemoteInput
import android.content.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import cn.replyassistant.ai.ModelClient
import cn.replyassistant.data.AssistantController
import cn.replyassistant.domain.*
import cn.replyassistant.platform.NotificationReplies
import cn.replyassistant.platform.NotificationTicket
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@RunWith(AndroidJUnit4::class)
class ControllerDeviceTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun main(block: () -> Unit) { instrumentation.runOnMainSync(block) }
    private fun server(): Pair<MockWebServer, ModelClient> {
        val cert = HeldCertificate.Builder().commonName("localhost").addSubjectAlternativeName("localhost").build()
        val serverCerts = HandshakeCertificates.Builder().heldCertificate(cert).build()
        val clientCerts = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val server = MockWebServer().apply { useHttps(serverCerts.sslSocketFactory(), false); start() }
        val client = ModelClient(OkHttpClient.Builder().sslSocketFactory(clientCerts.sslSocketFactory(), clientCerts.trustManager)
            .followRedirects(false).retryOnConnectionFailure(false).build())
        return server to client
    }
    private fun response() = MockResponse().setBody("""{"choices":[{"message":{"content":"{\"alternatives\":[\"周日下午可以呀\"],\"note\":\"\",\"uncertain\":false}"}}]}""")

    @Test fun screenshotPreviewGeneratesAndCopiedDraftSurvivesRestartWithoutBecomingHistory() {
        val (server, model) = server()
        server.use {
            server.enqueue(response())
            val endpoint = server.url("/chat/completions").toString()
            val namespace = "synthetic-${newId()}"
            lateinit var controller: AssistantController; var job: Job? = null; lateinit var id: String
            main {
                controller = AssistantController(context, model, namespace)
                controller.startPreview(); id = controller.createArchive("截图对象", "第三方软件")
                controller.updatePreview { it.copy(manualRows = listOf(ChatMessage(speaker = Speaker.OTHER, text = "周末有空吗"))) }
                controller.confirmBinding(true)
                controller.saveSettings(ModelSettings(textEndpoint = endpoint, textKey = "synthetic-key"))
                job = controller.generate("简短一点")
            }
            runBlocking { job!!.join() }
            assertEquals("周日下午可以呀", controller.state.value.archives.single().draft!!.text)
            main { controller.copyDraft() }
            assertEquals(1, controller.state.value.archives.single().messages.size)
            lateinit var restored: AssistantController
            main { restored = AssistantController(context, model, namespace) }
            assertEquals(DraftState.COPIED, restored.state.value.archives.single().draft!!.state)
            assertNull(restored.state.value.preview)
            assertEquals(id, restored.state.value.archives.single().id)
            main { controller.scope.cancel(); restored.scope.cancel() }
        }
    }
    @Test fun previewWithoutExplicitBindingDoesNotWriteChatOrCallModel() {
        lateinit var controller: AssistantController; var job: Job? = null
        main {
            controller = AssistantController(context, storageNamespace = "synthetic-${newId()}")
            controller.startPreview(); controller.createArchive("同名", "软件A")
            controller.updatePreview { it.copy(manualRows = listOf(ChatMessage(speaker = Speaker.OTHER, text = "内容"))) }
            controller.confirmBinding(false)
            job = controller.generate("")
        }
        runBlocking { job!!.join() }
        assertTrue(controller.state.value.archives.single().messages.isEmpty())
        assertTrue(controller.state.value.error.contains("档案归属"))
        assertNotNull(controller.state.value.preview)
        main { controller.scope.cancel() }
    }
    @Test fun newInboundWhileGeneratingRejectsStaleModelResultAndKeepsOldDraft() {
        val (server, model) = server()
        server.use {
            server.enqueue(response().setBodyDelay(500, TimeUnit.MILLISECONDS))
            val endpoint = server.url("/chat/completions").toString()
            lateinit var controller: AssistantController; var job: Job? = null; lateinit var id: String
            main {
                controller = AssistantController(context, model, "synthetic-${newId()}")
                id = controller.createArchive("甲", "测试")
                controller.mutateArchive(id) { ContextEngine.append(it, listOf(ChatMessage(speaker = Speaker.OTHER, text = "你好"))) }
                controller.mutateArchive(id) { it.copy(draft = ReplyDraft(contextRevision = it.revision, alternatives = listOf("保留原草稿"))) }
                controller.saveSettings(ModelSettings(textEndpoint = endpoint, textKey = "synthetic-key"))
                job = controller.generate("")
            }
            assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
            main { controller.mutateArchive(id) { ContextEngine.append(it, listOf(ChatMessage(speaker = Speaker.OTHER, text = "又有一件事"))) } }
            runBlocking { job!!.join() }
            assertEquals("保留原草稿", controller.state.value.archives.single().draft!!.text)
            assertTrue(controller.state.value.error.contains("新消息"))
            main { controller.scope.cancel() }
        }
    }
    @Test fun submittingStateRestoresAsUnknownAndCannotBeEditedToResend() {
        val namespace = "synthetic-${newId()}"
        lateinit var controller: AssistantController; lateinit var restored: AssistantController; lateinit var id: String
        main {
            controller = AssistantController(context, storageNamespace = namespace)
            id = controller.createArchive("甲", "测试")
            controller.mutateArchive(id) { it.copy(draft = ReplyDraft(contextRevision = 0, alternatives = listOf("回复"), state = DraftState.SUBMITTING)) }
            restored = AssistantController(context, storageNamespace = namespace); restored.selectArchive(id); restored.editDraft("改掉")
        }
        assertEquals(DraftState.UNKNOWN, restored.state.value.archives.single().draft!!.state)
        assertEquals("回复", restored.state.value.archives.single().draft!!.text)
        main { controller.scope.cancel(); restored.scope.cancel() }
    }
    @Test fun syntheticNotificationActionIsConsumedBeforeSecondClickAndIsNotMarkedDelivered() {
        val scope = "synthetic-${newId()}"; val source = newId(); val action = "cn.replyassistant.TEST_${newId()}"
        val received = CountDownLatch(1); val count = AtomicInteger(0)
        val receiver = object : BroadcastReceiver() { override fun onReceive(context: Context?, intent: Intent?) {
            if (RemoteInput.getResultsFromIntent(intent)?.getCharSequence("reply") == "测试回复") { count.incrementAndGet(); received.countDown() }
        } }
        context.registerReceiver(receiver, IntentFilter(action), Context.RECEIVER_NOT_EXPORTED)
        lateinit var controller: AssistantController
        var controllerCreated = false
        try {
            val pending = PendingIntent.getBroadcast(context, 991, Intent(action).setPackage(context.packageName), PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_CANCEL_CURRENT)
            NotificationReplies.put(NotificationTicket(scope, source, source, pending, arrayOf(RemoteInput.Builder("reply").setLabel("回复").build()), System.currentTimeMillis()))
            NotificationReplies.verify(scope, true)
            main {
                controller = AssistantController(context, storageNamespace = "synthetic-${newId()}")
                controllerCreated = true
                val id = controller.createArchive("合成通知", "测试")
                controller.mutateArchive(id) { it.copy(notificationScope = scope, messages = listOf(ChatMessage(speaker = Speaker.OTHER, text = "消息", sourceId = source)),
                    draft = ReplyDraft(contextRevision = 0, alternatives = listOf("测试回复"))) }
                controller.sendNotification()
                assertTrue(runCatching { controller.sendNotification() }.isFailure)
            }
            assertEquals(DraftState.SUBMITTED, controller.state.value.archives.single().draft!!.state)
            assertTrue("Synthetic receiver must get the RemoteInput result", received.await(5, TimeUnit.SECONDS)); assertEquals(1, count.get())
            assertEquals(1, controller.state.value.archives.single().messages.size)
        } finally { context.unregisterReceiver(receiver); NotificationReplies.verify(scope, false); main { if (controllerCreated) controller.scope.cancel() } }
    }
}
