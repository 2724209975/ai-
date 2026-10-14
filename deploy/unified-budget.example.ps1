# Load the same policy into Core, QQ Bridge, WeChat Bridge and the local portal before starting.
# Copy into a private configuration first; fill only an already authorized, unallocated budget.
# Zero amounts deliberately disable paid requests. This example grants no new money.
$taskUnifiedBudgetPath = if ($env:DEEPSEEK_SHARED_BUDGET_PATH) {
    [IO.Path]::GetFullPath($env:DEEPSEEK_SHARED_BUDGET_PATH)
} else {
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../.local-model-budget/shared.json'))
}
$env:MODEL_SHARED_BUDGET_PATH = $taskUnifiedBudgetPath
$env:MODEL_TOTAL_CNY_LIMIT = '0'
$env:MODEL_DAILY_CNY_LIMIT = '0'
$env:DEEPSEEK_DAILY_CALL_LIMIT = '300'
$env:DEEPSEEK_DAILY_TOKEN_LIMIT = '500000'
# CNY per million tokens: use the actual configured model's tariff; do not assume a vendor price.
$env:DEEPSEEK_INPUT_CNY_PER_MILLION = '0'
$env:DEEPSEEK_OUTPUT_CNY_PER_MILLION = '0'
$env:MEDIA_VISION_INPUT_CNY_PER_MILLION = '0'
$env:MEDIA_VISION_OUTPUT_CNY_PER_MILLION = '0'
$env:MEDIA_VOICE_INPUT_CNY_PER_MILLION = '0'
$env:MEDIA_VOICE_OUTPUT_CNY_PER_MILLION = '0'
$env:MEMORY_EMBEDDING_INPUT_CNY_PER_MILLION = '0'
# v2 registered models use their own CNY price snapshot in AI_V2_PROVIDERS_JSON.
# This file contains no API keys and does not enable cloud, images, embeddings or sending.
