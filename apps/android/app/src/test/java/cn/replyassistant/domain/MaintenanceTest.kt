package cn.replyassistant.domain

import org.junit.Assert.*
import org.junit.Test
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class MaintenanceTest {
 private val settings=ModelSettings(textKey="synthetic",textPrice=ModelPrice(2.0,8.0),dailyCnyLimit=1.0)
 @Test fun reservationsPersistAndOfflineGrantIsNeverReplenishedByDayChange(){
  val grant=LinkedBudget(budgetId="scope",phones=listOf(PhoneAllowance("phone",10000)))
  val l=UsagePolicy.append(UsageLedger(grant=grant,deviceId="phone"),settings,"text","cheap",1000,1000,0,1)
  assertEquals(10000L,l.spentMicroCny);val restart=Json.decodeFromString<UsageLedger>(Json.encodeToString(l));assertNotNull(runCatching {UsagePolicy.append(restart,settings,"text","cheap",1,1,100,101)}.exceptionOrNull())
 }
 @Test fun budgetRejectsMissingPricesAndDifferentModelsUseTheirOwnPrice(){
  val s=settings.copy(qualityPrice=ModelPrice(10.0,20.0),visionPrice=ModelPrice(3.0,4.0))
  assertEquals(30000L,UsagePolicy.append(UsageLedger(),s,"quality","high",1000,1000,0,1).spentMicroCny)
  assertEquals(7000L,UsagePolicy.append(UsageLedger(),s,"vision","visual",1000,1000,0,1).spentMicroCny)
  assertNotNull(runCatching {UsagePolicy.append(UsageLedger(),settings.copy(textPrice=ModelPrice()),"text","cheap",100,100,0,1)}.exceptionOrNull())
 }
 @Test fun dailyCallAndMoneyCapsHoldAndUnknownCallsRemainReserved(){
  val first=UsagePolicy.append(UsageLedger(),settings.copy(dailyCallLimit=1),"text","cheap",100,100,0,1)
  assertNotNull(runCatching {UsagePolicy.append(first,settings.copy(dailyCallLimit=1),"text","cheap",100,100,0,2)}.exceptionOrNull())
  assertNotNull(runCatching {UsagePolicy.append(UsageLedger(),settings.copy(dailyCnyLimit=.0001),"text","cheap",100,100,0,1)}.exceptionOrNull())
  assertNotNull(runCatching {UsagePolicy.append(first.copy(unsafe=true),settings,"text","cheap",100,100,0,2)}.exceptionOrNull())
 }
 @Test fun encryptedBackupRoundTripExcludesSecretsAndActiveBindings(){
  val a=ChatArchive(name="合成对象",notificationScope="secret-scope",messages=listOf(ChatMessage(speaker=Speaker.ME,text="你好",imagePath="/private/image.jpg")),draft=ReplyDraft(contextRevision=0,alternatives=listOf("手工文本"),text="修改后的手工稿",manuallyEdited=true))
  val p=ArchiveBackup.payload(listOf(a),settings.copy(textKey="NEVER_EXPORT_SECRET",linkConnection=LinkConnection("https://127.0.0.1:8791","f","device","NEVER_EXPORT_TOKEN")))
  val encrypted=ArchiveBackup.encrypt(p,"password-123".toCharArray());assertFalse(encrypted.toString(Charsets.UTF_8).contains("合成对象"))
  val restored=ArchiveBackup.decrypt(encrypted,"password-123".toCharArray());val raw=Json.encodeToString(restored);assertFalse(raw.contains("NEVER_EXPORT"));assertFalse(raw.contains("/private/image.jpg"));assertNull(restored.archives[0].notificationScope);assertEquals("修改后的手工稿",restored.archives[0].draft!!.text)
 }
 @Test fun wrongPasswordAndTamperingCannotRestoreAndMergePreservesCurrentData(){
  val a=ChatArchive(id="same",name="原档案");val p=ArchiveBackup.payload(listOf(a),settings);val encrypted=ArchiveBackup.encrypt(p,"password-123".toCharArray())
  assertNotNull(runCatching {ArchiveBackup.decrypt(encrypted,"wrong-pass".toCharArray())}.exceptionOrNull())
  val changed=encrypted.copyOf().also {it[it.size-10]=(it[it.size-10].toInt() xor 1).toByte()};assertNotNull(runCatching {ArchiveBackup.decrypt(changed,"password-123".toCharArray())}.exceptionOrNull())
  val current=a.copy(name="当前版本");assertEquals(listOf(current),ArchiveBackup.merge(listOf(current),p));assertEquals(1,ArchiveBackup.preview(p,setOf("same")).existing)
 }
 @Test fun configurationChecksRejectInvalidPricesAndCredentialsWithoutCallingNetwork(){
  assertTrue(ModelDiagnostics.errors(settings).isEmpty());assertTrue(ModelDiagnostics.errors(settings.copy(qualityEndpoint="https://host/v1")).isNotEmpty());assertTrue(ModelDiagnostics.errors(settings.copy(textKey="bad key")).isNotEmpty());assertTrue(ModelDiagnostics.errors(settings.copy(dailyCnyLimit=Double.NaN)).isNotEmpty());assertTrue(ModelDiagnostics.errors(settings.copy(textEndpoint="https://key@host/v1")).isNotEmpty())
 }
}
