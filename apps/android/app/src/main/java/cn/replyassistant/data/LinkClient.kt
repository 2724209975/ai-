package cn.replyassistant.data

import cn.replyassistant.domain.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URI
import java.security.MessageDigest
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.*

/** Only the certificate explicitly received in the pairing code is trusted. No trust-all client. */
class LinkHttpException(val status:Int,message:String):java.io.IOException(message)
class LinkClient {
    private val json=Json { ignoreUnknownKeys=true;encodeDefaults=true }
    private fun client(endpoint:String,fingerprint:String):OkHttpClient {
        val uri=URI(endpoint);val host=uri.host.orEmpty();val oct=host.split('.').mapNotNull { it.toIntOrNull() }
        require(uri.scheme=="https"&&uri.userInfo==null&&uri.query==null&&uri.fragment==null&&(uri.path.isNullOrEmpty()||uri.path=="/")&&oct.size==4&&oct.all { it in 0..255 }&&(oct[0]==10||oct[0]==192&&oct[1]==168||oct[0]==172&&oct[1] in 16..31||oct[0]==127)) { "请使用同一Wi-Fi的电脑配对地址" }
        require(fingerprint.matches(Regex("[a-f0-9]{64}"))) { "配对证书无效" }
        val trust=object:X509TrustManager {
            override fun getAcceptedIssuers()=emptyArray<X509Certificate>()
            override fun checkClientTrusted(chain:Array<out X509Certificate>?,authType:String?) { throw java.security.cert.CertificateException("Not a client") }
            override fun checkServerTrusted(chain:Array<out X509Certificate>?,authType:String?) {
                val cert=chain?.firstOrNull() ?: throw java.security.cert.CertificateException("Missing certificate")
                cert.checkValidity()
                val hash=MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString("") { "%02x".format(it) }
                if(hash!=fingerprint) throw java.security.cert.CertificateException("电脑证书已变化，请重新配对")
            }
        }
        val tls=SSLContext.getInstance("TLS").apply { init(null,arrayOf(trust),null) }
        return OkHttpClient.Builder().sslSocketFactory(tls.socketFactory,trust).hostnameVerifier { _,session ->
            runCatching { MessageDigest.getInstance("SHA-256").digest(session.peerCertificates.first().encoded).joinToString("") { "%02x".format(it) }==fingerprint }.getOrDefault(false)
        }.followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).connectTimeout(3,TimeUnit.SECONDS).callTimeout(20,TimeUnit.SECONDS).build()
    }
    suspend fun call(connection:LinkConnection,path:String,body:JsonElement?=null):JsonElement=withContext(Dispatchers.IO) {
        val request=Request.Builder().url(connection.endpoint.trimEnd('/')+"/link/v1/"+path).header("Authorization","Bearer ${connection.token}")
        if(body!=null)request.post(body.toString().toRequestBody("application/json".toMediaType()))
        client(connection.endpoint,connection.fingerprint).newCall(request.build()).execute().use {
            if(!it.isSuccessful) throw LinkHttpException(it.code,when(it.code){401->"电脑已撤销连接，请重新配对";409->"电脑资料已有新版本，请同步后重新选择";400->if(path=="pair") "配对码已过期或已使用，请在电脑重新生成" else "电脑联动未完成，请刷新后重试";else->"电脑联动未完成（${it.code}），请重试"})
            json.parseToJsonElement(it.body?.string() ?: error("电脑返回为空"))
        }
    }
    suspend fun pair(text:String):LinkConnection {
        val code=try {json.decodeFromString<PairingCode>(text)}catch(_:kotlinx.serialization.SerializationException){throw IllegalArgumentException("配对内容格式不正确，请复制完整内容或扫码")};require(code.protocol==1) { "不支持的配对版本" }
        val temp=LinkConnection(code.endpoint,code.fingerprint,"","")
        val r=call(temp,"pair",buildJsonObject {put("code",code.code);put("name",android.os.Build.MODEL) }).jsonObject
        return temp.copy(deviceId=r.getValue("deviceId").jsonPrimitive.content,token=r.getValue("token").jsonPrimitive.content)
    }
    suspend fun contacts(c:LinkConnection)=json.decodeFromJsonElement<List<DesktopContact>>(call(c,"contacts").jsonObject.getValue("items"))
    suspend fun budget(c:LinkConnection)=try {json.decodeFromJsonElement<LinkedBudget>(call(c,"budget"))}catch(e:LinkHttpException){if(e.status==404)LinkedBudget(supported=false)else throw e}
    suspend fun bind(c:LinkConnection,a:ChatArchive,contact:String?):LinkedArchive {
        val r=call(c,"bind",buildJsonObject {put("archiveId",a.id);put("contactId",contact?.let(::JsonPrimitive)?:JsonNull);put("profile",json.encodeToJsonElement(a.linkProfile()))}).jsonObject
        return LinkedArchive(r.getValue("id").jsonPrimitive.content,deviceId=c.deviceId,exportedProfile=a.linkProfile())
    }
    suspend fun sync(c:LinkConnection,a:ChatArchive):Pair<LinkedArchive,LinkProfile?> {
        var linked=requireNotNull(a.desktop)
        val operations=a.linkOperations(c.deviceId)
        val profile=a.linkProfile()
        val batches=operations.chunked(100).ifEmpty {listOf(emptyList())}
        var ownerReset=false
        for(batch in batches) {
            var more:Boolean
            var first=true
            do {
                val r=json.decodeFromJsonElement<SyncResult>(call(c,"groups/${linked.groupId}/sync",buildJsonObject {put("after",linked.cursor);put("resetRevision",linked.resetRevision);put("historyCorrections",true);put("personChannels",true);put("operations",json.encodeToJsonElement(if(first&&!ownerReset)batch else emptyList()))}))
                if(r.resetRevision>a.desktop!!.resetRevision)ownerReset=true
                val records=linked.records.associateBy {it.id}.toMutableMap();r.records.forEach {records[it.id]=it}
                linked=linked.copy(cursor=r.cursor,records=records.values.toList(),packet=r.packet,conflicts=r.conflicts,resetRevision=r.resetRevision)
                more=r.more;first=false
            }while(more)
        }
        val current=linked.records.find {it.id=="profile"&&!it.deleted};val p=current?.body?.let {json.decodeFromJsonElement<LinkProfile>(it)}
        val conflict=linked.conflicts.any {it.id=="profile"}
        val accepted=if(!conflict&&p!=null&&(linked.resetRevision>a.desktop!!.resetRevision||profile==a.desktop!!.exportedProfile||p==profile||current.resolved))p else null
        return linked.copy(exportedProfile=if(!conflict&&accepted!=null)accepted else a.desktop!!.exportedProfile,lastSyncedAt=System.currentTimeMillis()) to accepted
    }
}
