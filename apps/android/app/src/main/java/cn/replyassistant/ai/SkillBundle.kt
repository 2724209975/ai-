package cn.replyassistant.ai

import android.content.Context
import kotlinx.serialization.json.*
import java.security.MessageDigest

/** Reviewed Markdown assets, never an executable skill loader. */
class SkillBundle(private val context: Context) {
    private val texts: Map<String, String> by lazy {
        val manifest = Json.parseToJsonElement(context.assets.open("goutoujunshi/manifest.json").bufferedReader().use { it.readText() }).jsonObject
        require(manifest["commit"]?.jsonPrimitive?.content == "6db7354a4002dc7c448a9c87ffdad8132570c9d3") { "技能版本不正确" }
        manifest.getValue("files").jsonArray.associate { item ->
            val row = item.jsonObject
            val path = row.getValue("path").jsonPrimitive.content
            require(path in setOf("SKILL.md", "LICENSE") || Regex("references/(knowledge|practical)/[^/]+\\.md").matches(path))
            val bytes = context.assets.open("goutoujunshi/$path").use { it.readBytes() }
            val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            require(hash == row.getValue("sha256").jsonPrimitive.content && bytes.size == row.getValue("bytes").jsonPrimitive.int) { "技能资料校验失败" }
            path to bytes.toString(Charsets.UTF_8)
        }
    }
    fun payload(scene: String): String {
        val topic = when {
            Regex("危险|威胁|跟踪|胁迫|家暴|自伤|自杀").containsMatchIn(scene) -> "17-中国法律安全与危机转介.md"
            Regex("分手|复合|背叛|出轨").containsMatchIn(scene) -> "15-分手背叛与关系修复.md"
            Regex("吵架|争执|冲突|道歉").containsMatchIn(scene) -> "07-沟通冲突与修复.md"
            Regex("冷淡|投入|退出|单方面").containsMatchIn(scene) -> "关系投入失衡：互惠判断、降级投入与退出决策.md"
            Regex("约会|见面|邀约").containsMatchIn(scene) -> "主动表达、第一次见面与自然接触.md"
            Regex("MBTI|人格", RegexOption.IGNORE_CASE).containsMatchIn(scene) -> "04-MBTI人格与匹配.md"
            Regex("婚姻|结婚|家庭").containsMatchIn(scene) -> "11-婚姻家庭与生命周期.md"
            Regex("焦虑|情绪|依恋").containsMatchIn(scene) -> "03-依恋理论与情绪调节.md"
            Regex("松弛|调情|暧昧").containsMatchIn(scene) -> "场景感、松弛感与社交校准：从接话到关系推进.md"
            else -> null
        }
        val refs = listOfNotNull(topic, "实战话术编排器：从一句回复到后续分支.md", "09-在线约会与数字关系.md")
            .distinct().take(3).mapNotNull { name -> texts.entries.find { it.key.endsWith("/$name") } }
        return texts.getValue("SKILL.md") + refs.joinToString("\n") { "\n参考：${it.key}\n${it.value}" } +
            "\n手机宿主规则：不执行脚本、不读取其他联系人、不发送消息。首次问卷与评分均可选，不阻塞回复。先给成品，分析放advisor字段。只有宿主能保存记忆，不声称已保存。宿主JSON和明确偏好优先。"
    }
}
