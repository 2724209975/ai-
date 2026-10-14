package cn.replyassistant.domain

import kotlinx.serialization.Serializable
import java.util.UUID

fun newId(): String = UUID.randomUUID().toString()

@Serializable enum class Speaker { ME, OTHER, UNKNOWN }
@Serializable enum class Origin { SCREENSHOT, NOTIFICATION, ACCESSIBILITY, MANUAL, CONFIRMED_DRAFT }
@Serializable enum class DraftState { EDITING, COPIED, FILLED, SUBMITTING, SUBMITTED, UNKNOWN, SENT }

@Serializable data class ChatMessage(
    val id: String = newId(), val speaker: Speaker, val text: String,
    val timestamp: Long? = null, val origin: Origin = Origin.MANUAL,
    val sourceId: String = newId(), val generated: Boolean = false,
    val styleExample: Boolean = false, val uncertain: Boolean = false, val imagePath: String? = null, val layoutHint: String = "",
    val sourceRefs: List<String> = emptyList(), val orderUncertain: Boolean = false,
    val linkedStyleExample: Boolean? = null,
)
@Serializable data class SummaryChunk(val sourceIds: List<String>, val text: String)
@Serializable data class ReplyAttempt(val phase:String="context",val instruction:String="",val error:String="",val startedAt:Long=System.currentTimeMillis())
val replyRunningPhases=setOf("context","recognition","decision","generation","quality")
fun ChatArchive.recoverReplyAttempt():ChatArchive = if(replyAttempt?.phase in replyRunningPhases)copy(replyAttempt=replyAttempt!!.copy(phase="interrupted",error="上次生成因应用退出中断，内容和原草稿已保留")) else this
@Serializable data class ReplyDraft(
    val id: String = newId(), val contextRevision: Long, val alternatives: List<String>,
    val selected: Int = 0, val text: String = alternatives.firstOrNull().orEmpty(),
    val instruction: String = "", val state: DraftState = DraftState.EDITING,
    val contextV2:MobileContextV2?=null,val decisionV2:MobileDecisionV2?=null,val qualityV2:List<MobileQualityV2> = emptyList(),val generationModel:String="",
    val note: String = "", val uncertain: Boolean = false,
    val manuallyEdited: Boolean = false, val previewVersion: Long? = null,
    val advisor: AdvisorAnalysis? = null,
    val alternativeLabels: List<String> = emptyList(),
    val editedAlternatives: Map<Int, String> = emptyMap(),
)
@Serializable data class ChatArchive(
    val id: String = newId(), val name: String, val platform: String = "通用截图",
    val relationship: String = "", val style: String = "自然口语，简短，不用 Markdown，不编造经历或承诺",
    val temporary: Boolean = false, val enabled: Boolean = true,
    val notificationScope: String? = null, val revision: Long = 0,
    val messages: List<ChatMessage> = emptyList(), val summaries: List<SummaryChunk> = emptyList(),
    val draft: ReplyDraft? = null, val pending: Boolean = false,
    val preferences: List<SavedPreference> = emptyList(), val feedback: List<FeedbackRecord> = emptyList(),
    val draftHistory: List<ReplyDraft> = emptyList(), val skill: SkillConfig = SkillConfig(),
    val consultation: Consultation = Consultation(), val memory: RelationshipMemory = RelationshipMemory(),
    val updatedAt: Long = System.currentTimeMillis(),
    val lastUsedAt: Long = 0,
    val desktop: LinkedArchive? = null, val lastDecisionV2:MobileDecisionV2?=null,
    val historyUndo: List<ChatMessage>? = null,
    val replyAttempt: ReplyAttempt? = null,
    val personId: String? = null, val personName: String = "",
)
@Serializable data class ScreenshotPage(
    val id: String = newId(), val path: String, val rows: List<ChatMessage>,
    val includeVisual: Boolean = false, val imageDescription: String = "",
    val corrected: Boolean = false,
    val accessibleText: String = "",
)
@Serializable data class PreviewSession(
    val id: String = newId(), val archiveId: String? = null, val bindingConfirmed: Boolean = false,
    val pages: List<ScreenshotPage> = emptyList(), val manualRows: List<ChatMessage> = emptyList(),
    val instruction: String = "", val recommendedArchiveId: String? = null,
    val createdAt: Long = System.currentTimeMillis(),
    val version: Long = 0,
    val heldBatches: List<HeldScreenshotBatch> = emptyList(),
)
@Serializable data class HeldScreenshotBatch(val id: String = newId(), val archiveId: String?,
    val pages: List<ScreenshotPage>, val rows: List<ChatMessage>, val instruction: String, val version: Long = 0)
@Serializable data class ModelSettings(
    val textEndpoint: String = "https://api.deepseek.com/v1/chat/completions",
    val textModel: String = "deepseek-chat", val textKey: String = "",
    val visionEndpoint: String = "", val visionModel: String = "", val visionKey: String = "",
    val qualityEndpoint:String="",val qualityModel:String="",val qualityKey:String="",
    val dailyCallLimit:Int=40,val dailyTokenLimit:Int=200000,
    val dailyCnyLimit:Double=0.0,val visionPrice:ModelPrice=ModelPrice(),val textPrice:ModelPrice=ModelPrice(),val qualityPrice:ModelPrice=ModelPrice(),
    val globalStyle: String = "像日常聊天，简短自然。不要自称 AI，不写分析，不编造个人事实。",
    val preferences: List<SavedPreference> = emptyList(),
    val bubbleOpacity: Float = 1f, val panelOpacity: Float = 1f, val fastReplies: Boolean = true,
    val collapseAfterAction: Boolean = true,
    val paused: Boolean = false,
    val linkConnection: LinkConnection? = null, val pendingLinkDeletes: List<String> = emptyList(),
    val screenshotUploadAccepted: Boolean = false, val lastArchiveId: String? = null,
)
@Serializable data class ModelPrice(val inputPerMillion:Double=0.0,val outputPerMillion:Double=0.0)
@Serializable data class PhoneAllowance(val deviceId:String,val limitMicroCny:Long,val spentMicroCny:Long=0,val calls:Long=0,val tokens:Long=0,val updatedAt:Long=0)
@Serializable data class LinkedBudget(val supported:Boolean=true,val budgetId:String="",val limitMicroCny:Long=0,val desktopMicroCny:Long=0,val halted:Boolean=false,val phones:List<PhoneAllowance> = emptyList())
data class AssistantState(
    val archives: List<ChatArchive> = emptyList(), val preview: PreviewSession? = null,
    val selectedArchiveId: String? = null, val settings: ModelSettings = ModelSettings(),
    val advisorArchiveId: String? = null,
    val historyArchiveId: String? = null,
    val linkScreen: Boolean = false, val linkArchiveId: String? = null, val linkNeedsPairing: Boolean = false,
    val linkBusy: Boolean = false, val linkStatus: String = "未连接电脑", val desktopContacts: List<DesktopContact> = emptyList(),
    val busy: Boolean = false, val notice: String = "", val error: String = "",
    val captureStatus: String = "",
    val workLabel: String = "", val workStartedAt: Long = 0,
    val generationCancelled: Boolean = false,
    val backupBusy:Boolean=false,val backupPreview:BackupPreview?=null,
)

data class ReplyPanelPosition(val index: Int = 0, val offset: Int = 0, val editing: Boolean = false,
    val more: Boolean = false, val recent: Boolean = false, val rewrite: Boolean = false,
    val previewId: String? = null, val instruction: String? = null)

fun ReplyDraft.selectAlternative(index: Int): ReplyDraft {
    val saved = if (manuallyEdited) editedAlternatives + (selected to text) else editedAlternatives
    return copy(selected = index, text = saved[index] ?: alternatives[index], editedAlternatives = saved,
        manuallyEdited = index in saved, state = DraftState.EDITING)
}

@Serializable data class SavedPreference(val id: String = newId(), val text: String)
@Serializable data class FeedbackRecord(val id: String = newId(), val kind: String, val instruction: String, val draftId: String)
@Serializable data class SkillConfig(val enabled: Boolean = false, val version: String = "6db7354a4002dc7c448a9c87ffdad8132570c9d3")
@Serializable data class MemoryEntry(val id: String = newId(), val kind: String, val text: String, val sourceIds: List<String>)
@Serializable data class RelationshipMemory(val consent: Boolean = false, val paused: Boolean = false,
    val profile: String = "", val entries: List<MemoryEntry> = emptyList(), val undo: List<List<MemoryEntry>> = emptyList())
@Serializable data class AdvisorAnalysis(val summary: String = "", val facts: List<String> = emptyList(),
    val hypotheses: List<String> = emptyList(), val unknowns: List<String> = emptyList(), val actions: List<String> = emptyList())
@Serializable data class MemorySuggestion(val kind: String, val text: String, val sourceIds: List<String>)
@Serializable data class ConsultTurn(val id: String = newId(), val question: String, val background: String = "",
    val analysis: AdvisorAnalysis, val replies: List<String>, val imageDescriptions: List<String> = emptyList(),
    val sourceIds: List<String> = emptyList())
@Serializable data class Consultation(val turns: List<ConsultTurn> = emptyList(), val question: String = "",
    val background: String = "", val pages: List<ScreenshotPage> = emptyList(), val version: Long = 0)

/** Appearance changes must not discard an in-flight model result. */
fun ModelSettings.sameReplyConfiguration(other: ModelSettings): Boolean =
    copy(bubbleOpacity = 1f, panelOpacity = 1f, collapseAfterAction = true) == other.copy(bubbleOpacity = 1f, panelOpacity = 1f, collapseAfterAction = true)
