package cn.replyassistant.domain

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

object QwenPreset {
    const val endpoint = "https://dashscope.aliyuncs.com/compatible-mode/v1/"
    fun isOfficialHost(host: String?) = host == "dashscope.aliyuncs.com" || host == "dashscope-intl.aliyuncs.com" ||
        (host?.endsWith(".maas.aliyuncs.com") == true)
    fun apply(s: ModelSettings): ModelSettings {
        fun key(url: String, value: String) = if (isOfficialHost(url.toHttpUrlOrNull()?.host)) value else ""
        val text = key(s.textEndpoint,s.textKey)
        return s.copy(textEndpoint=endpoint,textModel="qwen3.7-flash",textKey=text,
            visionEndpoint=endpoint,visionModel="qwen3.7-flash",visionKey=key(s.visionEndpoint,s.visionKey),
            qualityEndpoint=endpoint,qualityModel="qwen3.5-plus",qualityKey=key(s.qualityEndpoint,s.qualityKey),
            textPrice=ModelPrice(1.2,4.8),visionPrice=ModelPrice(1.2,4.8),qualityPrice=ModelPrice(4.0,24.0),fastReplies=true)
    }
    fun reuseTextKey(s: ModelSettings): ModelSettings {
        require(s.textKey.isNotBlank() && isOfficialHost(s.textEndpoint.toHttpUrlOrNull()?.host) &&
            s.textEndpoint == s.visionEndpoint && s.textEndpoint == s.qualityEndpoint) { "请先填写同一百炼接口的低成本密钥" }
        return s.copy(visionKey=s.textKey,qualityKey=s.textKey)
    }
}
