package cn.replyassistant.domain

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class LinkUxTest {
    private val json=Json {encodeDefaults=true;ignoreUnknownKeys=true}
    @Test fun pendingCounterUsesVersionedWritesAndDeletesOnlyThisDevicesMessages() {
        val m=ChatMessage(id="one",speaker=Speaker.ME,text="旧话",origin=Origin.MANUAL)
        val a=ChatArchive(name="合成",messages=listOf(m))
        val linked=LinkedArchive("g",deviceId="d",exportedProfile=a.linkProfile(),records=listOf(
            LinkRecord("profile","profile",json.encodeToJsonElement(a.linkProfile()),3,1,false),
            LinkRecord("phone:d:one","message",json.encodeToJsonElement(m.linkMessage()),2,2,false),
            LinkRecord("phone:d:removed","message",json.encodeToJsonElement(m.linkMessage()),4,3,false),
            LinkRecord("desktop:other","message",json.encodeToJsonElement(m.linkMessage()),1,4,false)))
        val ops=a.copy(messages=listOf(m.copy(text="修改")),desktop=linked).linkOperations("d")
        assertEquals(2,ops.size);assertEquals(2L,ops.first().expectedVersion);assertTrue(ops.last().deleted)
        assertEquals("phone:d:removed",ops.last().id);assertEquals(4L,ops.last().expectedVersion)
    }
    @Test fun readableConflictShowsPreferencesAndConsentWithoutRawJson() {
        val p=ChatArchive(name="合成",relationship="朋友",style="简短",preferences=listOf(SavedPreference(text="不催回复"))).linkProfile()
        val text=linkVersionText("profile",json.encodeToJsonElement(p))
        assertTrue(text.contains("关系：朋友"));assertTrue(text.contains("不催回复"));assertFalse(text.contains("sourceIds"));assertFalse(text.contains("背景："))
        assertEquals("已删除",linkVersionText("message",null,true))
    }
    @Test fun oldCachedArchiveLoadsWithNewFieldsAndNoPendingWritesAfterAck() {
        val a=ChatArchive(name="合成")
        val linked=json.decodeFromString<LinkedArchive>("""{"groupId":"g","deviceId":"d"}""")
        assertEquals("仅整理手机资料",linked.contactLabel)
        assertEquals(1,a.copy(desktop=linked).linkOperations("d").size)
        val ack=linked.copy(exportedProfile=a.linkProfile(),records=listOf(LinkRecord("profile","profile",json.encodeToJsonElement(a.linkProfile()),1,1,false)))
        assertTrue(a.copy(desktop=ack).linkOperations("d").isEmpty())
    }
    @Test fun unresolvedVersionsRequireUserChoiceAndAreNotAutomaticallyReplayed() {
        val a=ChatArchive(name="合成",style="手机修改")
        val old=a.linkProfile().copy(style="原风格");val record=LinkRecord("profile","profile",json.encodeToJsonElement(old.copy(style="电脑修改")),2,2,false)
        val incoming=LinkOperation("profile","profile",json.encodeToJsonElement(a.linkProfile()),1)
        val linked=LinkedArchive("g",deviceId="d",records=listOf(record),exportedProfile=old,conflicts=listOf(LinkConflict("profile",incoming,record)))
        assertTrue(a.copy(desktop=linked).linkOperations("d").isEmpty())
        assertEquals(2L,a.copy(desktop=linked.copy(conflicts=emptyList())).linkOperations("d").single().expectedVersion)
    }
}
