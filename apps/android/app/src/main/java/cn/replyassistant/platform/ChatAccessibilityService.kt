package cn.replyassistant.platform

import android.accessibilityservice.AccessibilityService
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import cn.replyassistant.domain.*
import java.lang.ref.WeakReference

/** No autonomous click or message scraping. Each operation comes from an explicit user action. */
class ChatAccessibilityService : AccessibilityService() {
    companion object {
        private var instance = WeakReference<ChatAccessibilityService>(null)
        var targetPackage: String? = null
            private set
        fun connected(): Boolean = instance.get() != null
        fun rememberTarget(): String? {
            targetPackage = null
            targetPackage = instance.get()?.applicationRoot()?.packageName?.toString()
            return targetPackage
        }
        fun fill(text: String): Boolean = instance.get()?.fillCurrent(text) ?: false
        fun readCurrent(): List<ChatMessage>? = instance.get()?.readVisible()
    }
    override fun onServiceConnected() { instance = WeakReference(this) }
    override fun onDestroy() { if (instance.get() === this) instance.clear(); super.onDestroy() }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit
    override fun onInterrupt() = Unit

    private fun applicationRoot(): AccessibilityNodeInfo? {
        val candidates = windows.filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
            .sortedByDescending { it.isFocused || it.isActive }.mapNotNull { it.root }
            .filter { it.packageName?.toString() != packageName }
        return candidates.firstOrNull { targetPackage == null || it.packageName?.toString() == targetPackage }
    }
    private fun nodes(root: AccessibilityNodeInfo): List<AccessibilityNodeInfo> {
        val result = mutableListOf<AccessibilityNodeInfo>()
        fun visit(node: AccessibilityNodeInfo, depth: Int) {
            if (depth > 35 || result.size >= 1500) return
            result += node
            for (i in 0 until node.childCount) node.getChild(i)?.let { visit(it, depth + 1) }
        }
        visit(root, 0); return result
    }
    private fun fillCurrent(text: String): Boolean {
        if (text.isBlank() || text.length > 4000) return false
        val root = applicationRoot() ?: return false
        if (root.packageName?.toString() != targetPackage) return false
        val editable = nodes(root).filter { it.isEditable && it.isVisibleToUser && it.isEnabled && !it.isPassword }
        val focused = editable.filter { it.isFocused }
        val target = when { focused.size == 1 -> focused.single(); editable.size == 1 -> editable.single(); else -> return false }
        // Preserve text already entered by the user; never silently overwrite an unrelated draft.
        if (!target.isShowingHintText && !target.text.isNullOrBlank() && target.text.toString() != text) return false
        if (!target.actionList.any { it.id == AccessibilityNodeInfo.ACTION_SET_TEXT }) return false
        val ok = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        })
        if (!ok) return false
        target.refresh()
        return target.text?.toString() == text
    }
    private fun readVisible(): List<ChatMessage>? {
        val root = applicationRoot() ?: return null
        if (targetPackage == null || root.packageName?.toString() != targetPackage) return null
        val source = newId()
        return nodes(root).filter { it.isVisibleToUser && !it.isPassword && !it.isEditable && !it.text.isNullOrBlank() }
            .take(100).map { ChatMessage(speaker = Speaker.UNKNOWN, text = it.text.toString(),
                origin = Origin.ACCESSIBILITY, sourceId = source, uncertain = true) }.takeIf { it.isNotEmpty() }
    }
}
