package cn.replyassistant

import androidx.test.platform.app.InstrumentationRegistry
import cn.replyassistant.data.*
import cn.replyassistant.domain.*
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.*
import kotlinx.serialization.encodeToString
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.MockResponse
import okhttp3.tls.HeldCertificate
import okhttp3.tls.HandshakeCertificates
import org.junit.Test
import org.junit.Assert.*
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

class LinkDeviceTest {
    private val json=Json {encodeDefaults=true;ignoreUnknownKeys=true}
    @Test fun connectedDesktopPairingAndSyntheticSync()=runBlocking {
        val payload=InstrumentationRegistry.getArguments().getString("desktopPairing")
        org.junit.Assume.assumeTrue("Optional connected-device acceptance",!payload.isNullOrBlank())
        val client=LinkClient();val c=client.pair(payload!!)
        client.contacts(c) // Real Wi-Fi request, pinned certificate, scoped contact list.
        val archive=ChatArchive(name="联动验收（合成测试）",platform="测试",messages=(0 until 40).map {i->
            ChatMessage(speaker=if(i%2==0)Speaker.OTHER else Speaker.ME,text=if(i%2==0)"合成问题$i" else "合成回答$i",timestamp=1000L+i,origin=Origin.MANUAL)
        })
        val linked=client.bind(c,archive,null)
        try {
            val (received,_)=client.sync(c,archive.copy(desktop=linked))
            assertTrue(received.packet.ready);assertTrue(received.packet.summary.isNotBlank());assertTrue(received.packet.style.isNotBlank())
            assertEquals(41,received.records.size)
            val (again,_)=client.sync(c,archive.copy(desktop=received))
            assertEquals(received.cursor,again.cursor)
            val ctx=InstrumentationRegistry.getInstrumentation().targetContext
            val settings=SecureSettings(ctx);settings.save(settings.read().copy(linkConnection=c))
        }finally {client.call(c,"groups/${linked.groupId}/delete",buildJsonObject {})}
    }
    private fun server():Pair<MockWebServer,LinkConnection> {
        val cert=HeldCertificate.Builder().commonName("SyntheticDesktop").build()
        val tls=HandshakeCertificates.Builder().heldCertificate(cert).build()
        val server=MockWebServer().apply {useHttps(tls.sslSocketFactory(),false);start()}
        val hash=MessageDigest.getInstance("SHA-256").digest(cert.certificate.encoded).joinToString("") {"%02x".format(it)}
        return server to LinkConnection("https://127.0.0.1:${server.port}",hash,"synthetic-device","synthetic-token")
    }
    @Test fun pairingPinsCertificateAndRejectsChangedComputer()=runBlocking {
        val (server,c)=server()
        try {
            server.enqueue(MockResponse().setBody("{\"deviceId\":\"synthetic-device\",\"token\":\"synthetic-token\"}"))
            val connected=LinkClient().pair(json.encodeToString(PairingCode(1,c.endpoint,c.fingerprint,"one-use")))
            assertEquals(c,connected)
            assertTrue(server.takeRequest(3,TimeUnit.SECONDS)!!.body.readUtf8().contains("one-use"))
            try {LinkClient().contacts(c.copy(fingerprint="0".repeat(64)));fail("Changed certificate must be rejected")}catch(_:javax.net.ssl.SSLException){}
            assertEquals(1,server.requestCount)
        } finally {server.shutdown()}
    }
    @Test fun linkedContextSurvivesRestartAndSyncOmitsDraftsScreenshotsKeys()=runBlocking {
        val (server,c)=server();val ctx=InstrumentationRegistry.getInstrumentation().targetContext
        val namespace="synthetic-link-${newId()}";val controller=AssistantController(ctx,storageNamespace=namespace)
        try {
            val id=controller.createArchive("SyntheticLinked","测试")
            val original=controller.selected()!!.copy(messages=listOf(ChatMessage(speaker=Speaker.OTHER,text="真实保存原文")),draft=ReplyDraft(contextRevision=0,alternatives=listOf("不得上传的草稿")),desktop=LinkedArchive("group",deviceId=c.deviceId))
            val profile=original.linkProfile()
            val message=LinkMessage(Speaker.OTHER,"电脑最近来信",100,false,false,false,"desktop-source")
            val packet=ContextPacket(revision=3,summary="带来源的较早背景",sourceIds=listOf("desktop:old"),style="简短自然",examples=listOf("对方消息 → 本人表达"))
            val response=SyncResult(3,3,false,listOf(LinkRecord("profile","profile",json.encodeToJsonElement(profile),1,1,false),LinkRecord("desktop:one","message",json.encodeToJsonElement(message),1,3,false)),packet,emptyList())
            server.enqueue(MockResponse().setBody(json.encodeToString(response)))
            val (linked,accepted)=LinkClient().sync(c,original)
            val request=server.takeRequest(3,TimeUnit.SECONDS)!!.body.readUtf8()
            assertFalse(request.contains("不得上传的草稿"));assertFalse(request.contains("visionKey"));assertFalse(request.contains("image_url"));assertFalse(request.contains("path"));assertTrue(request.contains("真实保存原文"))
            controller.mutateArchive(id){original.copy(desktop=linked)}
            assertEquals(profile,accepted)
            val restored=AssistantController(ctx,storageNamespace=namespace)
            try {
                val archive=restored.state.value.archives.single()
                assertEquals("不得上传的草稿",archive.draft!!.text)
                val prompt=ContextEngine.prompt(archive,"本次优先要求","全局风格")
                assertTrue(prompt.contains("电脑最近来信"));assertTrue(prompt.contains("较早背景"));assertTrue(prompt.contains("本次优先要求"))
                assertEquals(1,archive.messages.size)
            }finally {restored.scope.cancel()}
        }finally {controller.scope.cancel();server.shutdown()}
    }
    @Test fun profileConflictDoesNotOverwriteLocalPreference()=runBlocking {
        val (server,c)=server()
        try {
            val a=ChatArchive(name="SyntheticConflict",style="手机修改")
            val old=a.linkProfile().copy(style="原偏好");val current=old.copy(style="电脑修改")
            val record=LinkRecord("profile","profile",json.encodeToJsonElement(current),2,2,false)
            val linked=LinkedArchive("group",deviceId=c.deviceId,cursor=1,records=listOf(record.copy(body=json.encodeToJsonElement(old),version=1,seq=1)),exportedProfile=old)
            val incoming=LinkOperation("profile","profile",json.encodeToJsonElement(a.linkProfile()),1)
            val response=SyncResult(2,2,false,listOf(record),ContextPacket(),listOf(LinkConflict("profile",incoming,record)))
            server.enqueue(MockResponse().setBody(json.encodeToString(response)))
            val (result,accepted)=LinkClient().sync(c,a.copy(desktop=linked))
            assertNull(accepted);assertEquals(1,result.conflicts.size);assertEquals(old,result.exportedProfile)
            server.takeRequest(3,TimeUnit.SECONDS)
            server.enqueue(MockResponse().setBody(json.encodeToString(response.copy(records=emptyList()))))
            val (refreshed,again)=LinkClient().sync(c,a.copy(desktop=result))
            val refreshRequest=json.parseToJsonElement(server.takeRequest(3,TimeUnit.SECONDS)!!.body.readUtf8()).jsonObject
            assertTrue(refreshRequest.getValue("operations").jsonArray.isEmpty())
            assertNull(again);assertEquals(1,refreshed.conflicts.size)
        }finally {server.shutdown()}
    }
}
