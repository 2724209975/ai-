package cn.replyassistant

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import cn.replyassistant.data.*
import cn.replyassistant.domain.*
import cn.replyassistant.ui.*
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.*
import kotlinx.serialization.encodeToString
import okhttp3.mockwebserver.*
import okhttp3.tls.*
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class LinkUxUiTest {
    @get:Rule val compose=createComposeRule()
    @Test fun failedPairKeepsPastedContentAndArchiveSearchDisambiguatesPlatform() {
        lateinit var controller:AssistantController
        compose.runOnUiThread {
            controller=AssistantController(InstrumentationRegistry.getInstrumentation().targetContext,storageNamespace="link-ui-${newId()}")
            val id=controller.createArchive("同名对象","微信")
            controller.createArchive("同名对象","QQ")
            controller.createArchive("临时对象","微信",temporary=true)
            controller.openLink(id)
        }
        try {
            compose.setContent {AssistantTheme {AssistantApp(controller,{}, {})}}
            compose.onNode(hasSetTextAction()).performTextInput("错误的配对内容")
            compose.onNodeWithText("连接电脑",useUnmergedTree=true).performClick()
            compose.waitUntil(5000){controller.state.value.linkStatus.contains("格式不正确")}
            compose.onNode(hasSetTextAction()).assertTextContains("错误的配对内容")
            compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("同名对象 · 微信 ▾"))
            compose.onNodeWithText("同名对象 · 微信 ▾").performClick()
            compose.onNodeWithText("搜索名称 / 平台").performTextInput("QQ")
            compose.onNodeWithText("同名对象 · QQ").assertExists().performClick()
            compose.onNodeWithText("同名对象 · QQ ▾").assertExists()
            compose.onNodeWithText("临时对象 · 微信").assertDoesNotExist()
        } finally {controller.scope.cancel()}
    }
    @Test fun cachedHistoryAndLinkReturnRemainUsableWithoutComputer() {
        lateinit var controller:AssistantController
        compose.runOnUiThread {
            controller=AssistantController(InstrumentationRegistry.getInstrumentation().targetContext,storageNamespace="link-cache-ui-${newId()}")
            val id=controller.createArchive("离线合成对象","微信")
            controller.mutateArchive(id){it.copy(desktop=LinkedArchive("cached",packet=ContextPacket(summary="上次音乐会在东门见面",sourceIds=listOf("desktop:old")),lastSyncedAt=100),messages=listOf(ChatMessage(speaker=Speaker.OTHER,text="合成聊天原文")))}
            controller.openLink(id)
        }
        try {
            compose.setContent {AssistantTheme {AssistantApp(controller,{}, {})}}
            val list=compose.onNode(hasScrollToIndexAction())
            list.performScrollToNode(hasText("上次音乐会在东门见面"))
            compose.onNodeWithText("上次音乐会在东门见面").assertExists()
            compose.onNodeWithText("当前未关联，以下为此前下载的资料。").assertExists()
            list.performScrollToNode(hasText("查看手机与电脑聊天原文"))
            compose.onNodeWithText("查看手机与电脑聊天原文").performClick()
            compose.onNodeWithText("合成聊天原文").assertExists()
            compose.onNodeWithText("返回").performClick()
            compose.onNodeWithText("电脑联动").assertExists()
        } finally {controller.scope.cancel()}
    }
    @Test fun contactSearchAndConflictChoiceUseSelectedPlatformAndReadableVersions() {
        val cert=HeldCertificate.Builder().commonName("SyntheticDesktop").build()
        val tls=HandshakeCertificates.Builder().heldCertificate(cert).build()
        val server=MockWebServer().apply {useHttps(tls.sslSocketFactory(),false);start()}
        val hash=MessageDigest.getInstance("SHA-256").digest(cert.certificate.encoded).joinToString("") {"%02x".format(it)}
        val c=LinkConnection("https://127.0.0.1:${server.port}",hash,"d","token")
        val json=Json {encodeDefaults=true;ignoreUnknownKeys=true}
        val a=ChatArchive(name="同名对象",platform="QQ",style="手机偏好")
        val phone=a.linkProfile();val computer=phone.copy(style="电脑偏好")
        val record=LinkRecord("profile","profile",json.encodeToJsonElement(computer),2,2,false)
        val resolved=AtomicBoolean(false);val bound=AtomicReference("")
        server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse {
            val response=when(request.path) {
                "/link/v1/contacts"->"""{"items":[{"id":"wx","name":"同名对象","platform":"微信"},{"id":"qq","name":"同名对象","platform":"QQ"}]}"""
                "/link/v1/bind"->{bound.set(json.parseToJsonElement(request.body.readUtf8()).jsonObject.getValue("contactId").jsonPrimitive.content);"""{"id":"g"}"""}
                "/link/v1/groups/g/resolve"->{val body=json.parseToJsonElement(request.body.readUtf8()).jsonObject;assertEquals("incoming",body.getValue("side").jsonPrimitive.content);assertEquals(2,body.getValue("expectedVersion").jsonPrimitive.int);resolved.set(true);"{}"}
                else->json.encodeToString(SyncResult(if(resolved.get())3 else 2,if(resolved.get())3 else 2,false,
                    listOf(if(resolved.get())record.copy(body=json.encodeToJsonElement(phone),version=3,seq=3,resolved=true) else record),ContextPacket(),
                    if(resolved.get())emptyList() else listOf(LinkConflict("profile",LinkOperation("profile","profile",json.encodeToJsonElement(phone),1),record))))
            }
            return MockResponse().setBody(response)
        }}
        lateinit var controller:AssistantController
        compose.runOnUiThread {
            val ns="link-contact-ui-${newId()}";val ctx=InstrumentationRegistry.getInstrumentation().targetContext
            LocalStore(ctx,"$ns.db").save(listOf(a),null);SecureSettings(ctx,"${ns}_settings").save(ModelSettings(linkConnection=c))
            controller=AssistantController(ctx,storageNamespace=ns);controller.openLink(a.id)
        }
        try {
            compose.setContent {AssistantTheme {AssistantApp(controller,{}, {})}}
            compose.waitUntil(5000){controller.state.value.desktopContacts.size==2&&!controller.state.value.linkBusy}
            val list=compose.onNode(hasScrollToIndexAction())
            list.performScrollToNode(hasText("仅整理手机资料 ▾"));compose.onNodeWithText("仅整理手机资料 ▾").performClick()
            compose.onNodeWithText("搜索名称 / 平台").performTextInput("QQ")
            compose.onNodeWithText("同名对象 · QQ").performClick()
            list.performScrollToNode(hasText("关联当前对象"));compose.onNodeWithText("关联当前对象").performClick()
            compose.waitUntil(10000){controller.state.value.archives.single().desktop?.conflicts?.size==1&&!controller.state.value.linkBusy}
            assertEquals("qq",bound.get());assertEquals("同名对象 · QQ",controller.state.value.archives.single().desktop!!.contactLabel)
            list.performScrollToNode(hasText("使用待合并版本"))
            compose.onNodeWithText("关系：未填写\n风格：手机偏好\n偏好：未填写").assertExists()
            compose.onNodeWithText("使用待合并版本").performClick()
            compose.waitUntil(10000){resolved.get()&&controller.state.value.archives.single().desktop!!.conflicts.isEmpty()&&!controller.state.value.linkBusy}
            assertEquals("手机偏好",controller.state.value.archives.single().style)
        } finally {controller.scope.cancel();server.shutdown()}
    }
}
