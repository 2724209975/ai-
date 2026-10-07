package cn.replyassistant.domain

import org.junit.Assert.*
import org.junit.Test

class NotificationIdentityTest {
    @Test fun `same nickname and reused notification key do not merge unidentified people`() {
        val a = NotificationIdentityFactory.create("wechat", "同名", null, null, "reused-id", 100, "你好")
        val b = NotificationIdentityFactory.create("wechat", "同名", null, null, "reused-id", 200, "你好")
        assertFalse(a.stable); assertNotEquals(a.scope, b.scope)
    }
    @Test fun `verified thread can continue across events`() {
        val a = NotificationIdentityFactory.create("qq", "甲", "thread-1", null, "id", 1, "第一条")
        val b = NotificationIdentityFactory.create("qq", "甲", "thread-1", null, "id", 2, "第二条")
        assertTrue(a.stable); assertEquals(a.scope, b.scope)
    }
    @Test fun `matching display names across platforms remain independent`() {
        val a = NotificationIdentityFactory.create("wechat", "甲", "thread-1", null, "id", 1, "你好")
        val b = NotificationIdentityFactory.create("qq", "甲", "thread-1", null, "id", 1, "你好")
        assertNotEquals(a.scope, b.scope)
    }
    @Test fun `a person key separates same name contacts`() {
        val a = NotificationIdentityFactory.create("qq", "甲", null, "person-1", "id", 1, "你好")
        val b = NotificationIdentityFactory.create("qq", "甲", null, "person-2", "id", 1, "你好")
        assertNotEquals(a.scope, b.scope)
    }
}
