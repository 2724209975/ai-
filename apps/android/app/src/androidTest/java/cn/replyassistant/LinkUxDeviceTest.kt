package cn.replyassistant

import androidx.test.platform.app.InstrumentationRegistry
import cn.replyassistant.data.*
import cn.replyassistant.domain.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import kotlinx.serialization.encodeToString
import okhttp3.mockwebserver.*
import okhttp3.tls.*
import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class LinkUxDeviceTest {
    private val json=Json {encodeDefaults=true;ignoreUnknownKeys=true}
    private val ctx get()=InstrumentationRegistry.getInstrumentation().targetContext
    private fun server():Pair<MockWebServer,LinkConnection> {
        val cert=HeldCertificate.Builder().commonName("SyntheticDesktop").build()
        val tls=HandshakeCertificates.Builder().heldCertificate(cert).build()
        val server=MockWebServer().apply {useHttps(tls.sslSocketFactory(),false);start()}
        val hash=MessageDigest.getInstance("SHA-256").digest(cert.certificate.encoded).joinToString("") {"%02x".format(it)}
        return server to LinkConnection("https://127.0.0.1:${server.port}",hash,"synthetic-device","synthetic-token")
    }
    private suspend fun controller(c:LinkConnection,archives:List<ChatArchive>):AssistantController=withContext(Dispatchers.Main) {
        val ns="link-ux-${newId()}"
        LocalStore(ctx,"$ns.db").save(archives,null)
        SecureSettings(ctx,"${ns}_settings").save(ModelSettings(linkConnection=c,lastArchiveId=archives.first().id))
        AssistantController(ctx,storageNamespace=ns)
    }
    private fun archive(c:LinkConnection,id:String="one"):ChatArchive {
        val a=ChatArchive(id=id,name="合成$id",messages=listOf(ChatMessage(id="m",speaker=Speaker.OTHER,text="旧内容")),draft=ReplyDraft(contextRevision=0,alternatives=listOf("保留草稿")))
        return a.copy(desktop=LinkedArchive("group-$id",deviceId=c.deviceId,exportedProfile=a.linkProfile(),records=listOf(LinkRecord("profile","profile",json.encodeToJsonElement(a.linkProfile()),1,1,false)),packet=ContextPacket(summary="离线可用背景"),lastSyncedAt=100))
    }
    private suspend fun await(predicate:()->Boolean) {withTimeout(10_000){while(!predicate())delay(50)}}
    @Test fun currentObjectSyncLeavesOtherObjectAndDraftUntouched()=runBlocking {
        val (server,c)=server();val a=archive(c);val b=archive(c,"two");val ctrl=controller(c,listOf(a,b))
        try {
            server.enqueue(MockResponse().setBody(json.encodeToString(SyncResult(2,2,false,a.desktop!!.records,ContextPacket(summary="新电脑背景"),emptyList()))))
            withContext(Dispatchers.Main){ctrl.syncDesktop(a.id)}
            await {ctrl.state.value.archives.first().desktop!!.lastSyncedAt>100&&!ctrl.state.value.linkBusy}
            assertEquals("/link/v1/groups/group-one/sync",server.takeRequest(3,TimeUnit.SECONDS)!!.path)
            assertEquals(1,server.requestCount);assertEquals(b,ctrl.state.value.archives.last())
            assertEquals("保留草稿",ctrl.state.value.archives.first().draft!!.text)
        } finally {ctrl.scope.cancel();server.shutdown()}
    }
    @Test fun uploadAcknowledgementDoesNotMakeUnchangedReplyStale()=runBlocking {
        val (server,c)=server();val a=archive(c);val ctrl=controller(c,listOf(a))
        try {
            val ack=LinkRecord("phone:${c.deviceId}:m","message",json.encodeToJsonElement(a.messages.single().linkMessage()),1,2,false)
            server.enqueue(MockResponse().setBody(json.encodeToString(SyncResult(2,2,false,a.desktop!!.records+ack,a.desktop.packet.copy(revision=2),emptyList()))))
            withContext(Dispatchers.Main){ctrl.syncDesktop()}
            await {ctrl.state.value.archives.single().desktop!!.lastSyncedAt>100&&!ctrl.state.value.linkBusy}
            val synced=ctrl.state.value.archives.single();assertEquals(0L,synced.revision);assertEquals(synced.revision,synced.draft!!.contextRevision)
            assertTrue(synced.linkOperations(c.deviceId).isEmpty())
        }finally {ctrl.scope.cancel();server.shutdown()}
    }
    @Test fun offlineAndRevokedHaveDistinctStatusAndKeepCachedContext()=runBlocking {
        val (server,c)=server();val a=archive(c);val ctrl=controller(c,listOf(a))
        try {
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
            withContext(Dispatchers.Main){ctrl.syncDesktop()}
            await {ctrl.state.value.linkStatus.contains("不可达")&&!ctrl.state.value.linkBusy}
            assertFalse(ctrl.state.value.linkNeedsPairing)
            assertTrue(ctrl.state.value.archives.single().desktopPrompt().contains("离线可用背景"))
            server.enqueue(MockResponse().setResponseCode(401).setBody("{\"code\":\"UNAUTHORIZED\"}"))
            withContext(Dispatchers.Main){ctrl.syncDesktop()}
            await {ctrl.state.value.linkNeedsPairing&&!ctrl.state.value.linkBusy}
            assertTrue(ctrl.state.value.linkStatus.contains("重新配对"));assertEquals(a,ctrl.state.value.archives.single())
        } finally {ctrl.scope.cancel();server.shutdown()}
    }
    @Test fun editsDuringSyncRetainLocalTextAndResumeWithAcknowledgedVersion()=runBlocking {
        val (server,c)=server();val a=archive(c);val ctrl=controller(c,listOf(a))
        val entered=CountDownLatch(1);val release=CountDownLatch(1)
        val records=a.desktop!!.records.associateBy {it.id}.toMutableMap();val uploads=mutableListOf<LinkOperation>();var seq=1L
        server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse {
            val ops=json.decodeFromJsonElement<List<LinkOperation>>(json.parseToJsonElement(request.body.readUtf8()).jsonObject.getValue("operations"))
            for(op in ops){synchronized(uploads){uploads+=op};val prior=records[op.id];records[op.id]=LinkRecord(op.id,op.kind,op.body,(prior?.version?:0)+1,++seq,op.deleted)}
            if(server.requestCount==1){entered.countDown();release.await(5,TimeUnit.SECONDS)}
            return MockResponse().setBody(json.encodeToString(SyncResult(seq,seq,false,records.values.toList(),ContextPacket(),emptyList())))
        }}
        try {
            withContext(Dispatchers.Main){ctrl.syncDesktop()};assertTrue(entered.await(5,TimeUnit.SECONDS))
            withContext(Dispatchers.Main){ctrl.mutateArchive(a.id){it.copy(messages=it.messages.map {m->m.copy(text="同步时修改")})}}
            release.countDown()
            await {ctrl.state.value.archives.single().linkOperations(c.deviceId).isEmpty()&&!ctrl.state.value.linkBusy}
            val sent=synchronized(uploads){uploads.filter {it.kind=="message"}.toList()}
            assertEquals(listOf(0L,1L),sent.map {it.expectedVersion});assertTrue(sent.last().body.toString().contains("同步时修改"))
            assertEquals("同步时修改",ctrl.state.value.archives.single().messages.single().text)
            assertEquals("保留草稿",ctrl.state.value.archives.single().draft!!.text)
        } finally {release.countDown();ctrl.scope.cancel();server.shutdown()}
    }
}
