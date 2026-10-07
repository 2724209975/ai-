package cn.replyassistant.domain

import java.security.MessageDigest

data class NotificationIdentity(val scope: String, val stable: Boolean)
object NotificationIdentityFactory {
    fun create(packageName: String, title: String, shortcutId: String?, senderKey: String?,
        eventKey: String, eventTime: Long, lastText: String): NotificationIdentity {
        val stableId = shortcutId?.takeIf { it.isNotBlank() } ?: senderKey?.takeIf { it.isNotBlank() }
        val scope = if (stableId != null) "thread:${digest("$packageName|$stableId|$title")}" else
            "event:${digest("$packageName|$eventKey|$eventTime|$title|$lastText")}" // notification id and nickname are not a contact identity
        return NotificationIdentity(scope, stableId != null)
    }
    fun digest(value: String): String = MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
        .joinToString("") { "%02x".format(it) }
}
