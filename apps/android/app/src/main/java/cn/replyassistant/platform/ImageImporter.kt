package cn.replyassistant.platform

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import cn.replyassistant.domain.*
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import java.io.File

class ImageImporter(private val context: Context) {
    suspend fun import(uri: Uri): ScreenshotPage = withContext(Dispatchers.IO) {
        val raw = File(context.cacheDir, "import-${newId()}.tmp")
        try {
            context.contentResolver.openInputStream(uri)?.use { input ->
                raw.outputStream().use { output ->
                    val buffer = ByteArray(8192); var total = 0
                    while (true) {
                        val count = input.read(buffer); if (count < 0) break
                        total += count; require(total <= 25_000_000) { "图片文件过大，请裁剪后再导入" }
                        output.write(buffer, 0, count)
                    }
                }
            } ?: error("无法读取图片，请重新分享或选择")
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(raw.path, bounds)
            require(bounds.outWidth > 0 && bounds.outHeight > 0) { "无法解码图片" }
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 4096) sample *= 2
            val bitmap = BitmapFactory.decodeFile(raw.path, BitmapFactory.Options().apply { inSampleSize = sample })
                ?: error("图片解码失败")
            try { fromBitmap(bitmap) } finally { bitmap.recycle() }
        } finally { raw.delete() }
    }

    suspend fun fromBitmap(bitmap: Bitmap, recognize: Boolean = false): ScreenshotPage {
        val id = newId()
        val directory = File(context.cacheDir, "screenshots").apply { mkdirs() }
        val file = File(directory, "$id.jpg")
        withContext(Dispatchers.IO) {
            val factor = minOf(1f,2560f / maxOf(bitmap.width,bitmap.height))
            val upload = if (factor < 1f) Bitmap.createScaledBitmap(bitmap,(bitmap.width*factor).toInt().coerceAtLeast(1),(bitmap.height*factor).toInt().coerceAtLeast(1),true) else bitmap
            try { file.outputStream().use { require(upload.compress(Bitmap.CompressFormat.JPEG,85,it)) } }
            finally { if (upload !== bitmap) upload.recycle() }
        }
        if (!recognize) return ScreenshotPage(id = id, path = file.path, rows = emptyList())
        val recognizer = TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
        try {
            val text = recognizer.process(InputImage.fromBitmap(bitmap, 0)).await()
            val rows = text.textBlocks.sortedWith(compareBy({ it.boundingBox?.top ?: 0 }, { it.boundingBox?.left ?: 0 })).map { block ->
                val box = block.boundingBox
                // OCR layout is a hint only: all roles remain UNKNOWN until the user confirms.
                val hint = when {
                    box == null -> ""
                    box.centerX() > bitmap.width * 0.60 -> "位置偏右，可能是本人"
                    box.centerX() < bitmap.width * 0.40 -> "位置偏左，可能是对方"
                    else -> "可能是标题、时间或系统文字"
                }
                ChatMessage(speaker = Speaker.UNKNOWN, text = block.text, origin = Origin.SCREENSHOT, sourceId = id,
                    uncertain = true, layoutHint = hint)
            }
            return ScreenshotPage(id = id, path = file.path, rows = rows)
        } catch (e: Exception) { file.delete(); throw e } finally { recognizer.close() }
    }

    suspend fun recognize(page: ScreenshotPage): ScreenshotPage = withContext(Dispatchers.IO) {
        val bitmap = BitmapFactory.decodeFile(page.path) ?: error("截图已不可用，请重新选择")
        try {
            val result = fromBitmap(bitmap, recognize = true)
            File(result.path).delete()
            page.copy(rows = result.rows.map { it.copy(sourceId = page.id) })
        } finally { bitmap.recycle() }
    }
}
