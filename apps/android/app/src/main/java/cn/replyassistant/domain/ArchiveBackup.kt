package cn.replyassistant.domain

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

@Serializable data class BackupPayload(val version:Int=1,val createdAt:Long=System.currentTimeMillis(),val archives:List<ChatArchive>,val globalStyle:String,val preferences:List<SavedPreference>)
@Serializable private data class BackupEnvelope(val format:String="reply-assistant-backup",val version:Int=1,val iterations:Int=210000,val salt:String,val iv:String,val ciphertext:String)
data class BackupPreview(val createdAt:Long,val names:List<String>,val messages:Int,val drafts:Int,val existing:Int)
object ArchiveBackup {
 const val MAX_BYTES=20_000_000
 private val json=Json {ignoreUnknownKeys=false;encodeDefaults=true}
 private val base64=Base64.getEncoder()
 private fun draft(d:ReplyDraft?)=d?.copy(state=DraftState.EDITING)
 fun portable(a:ChatArchive)=a.copy(notificationScope=null,desktop=a.desktop?.copy(active=false,deviceId="",conflicts=emptyList()),pending=false,revision=a.revision+1,
  messages=a.messages.map {it.copy(imagePath=null)},historyUndo=a.historyUndo?.map {it.copy(imagePath=null)},draft=draft(a.draft),draftHistory=a.draftHistory.map {draft(it)!!},consultation=a.consultation.copy(pages=emptyList()))
 fun payload(archives:List<ChatArchive>,s:ModelSettings)=BackupPayload(archives=archives.map(::portable),globalStyle=s.globalStyle,preferences=s.preferences)
 private fun key(password:CharArray,salt:ByteArray,iterations:Int):SecretKeySpec {val spec=PBEKeySpec(password,salt,iterations,256);return try {SecretKeySpec(SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded,"AES")}finally{spec.clearPassword()}}
 fun encrypt(payload:BackupPayload,password:CharArray):ByteArray {
  require(password.size>=8){"备份密码至少8位，请妥善保存"};val salt=ByteArray(16).also {SecureRandom().nextBytes(it)}
  val c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,key(password,salt,210000));c.updateAAD("reply-assistant-backup:1".toByteArray())
  val raw=json.encodeToString(payload).toByteArray(Charsets.UTF_8);require(raw.size<MAX_BYTES*3/4){"备份内容过大，请减少档案数量"}
  return json.encodeToString(BackupEnvelope(salt=base64.encodeToString(salt),iv=base64.encodeToString(c.iv),ciphertext=base64.encodeToString(c.doFinal(raw)))).toByteArray(Charsets.UTF_8)
 }
 fun decrypt(bytes:ByteArray,password:CharArray):BackupPayload {
  require(bytes.size in 1..MAX_BYTES){"备份文件为空或超过20MB"}
  val e=json.decodeFromString<BackupEnvelope>(bytes.toString(Charsets.UTF_8));require(e.format=="reply-assistant-backup"&&e.version==1&&e.iterations==210000){"备份版本不支持，请更新应用"}
  val decode=Base64.getDecoder();val salt=decode.decode(e.salt);val iv=decode.decode(e.iv);require(salt.size==16&&iv.size==12){"备份格式不正确"}
  val c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,key(password,salt,e.iterations),GCMParameterSpec(128,iv));c.updateAAD("reply-assistant-backup:1".toByteArray())
  val p=json.decodeFromString<BackupPayload>(c.doFinal(decode.decode(e.ciphertext)).toString(Charsets.UTF_8))
  require(p.version==1&&p.archives.size<=1000&&p.archives.map {it.id}.distinct().size==p.archives.size&&p.archives.all {it.id.length in 1..180&&it.name.length in 1..200}){"备份档案无效"}
  return p.copy(archives=p.archives.map(::portable))
 }
 fun preview(p:BackupPayload,existing:Set<String>)=BackupPreview(p.createdAt,p.archives.map {it.name},p.archives.sumOf {it.messages.size},p.archives.count {it.draft!=null},p.archives.count {it.id in existing})
 fun merge(existing:List<ChatArchive>,p:BackupPayload)=existing+p.archives.filterNot {a->existing.any {it.id==a.id}}
}
