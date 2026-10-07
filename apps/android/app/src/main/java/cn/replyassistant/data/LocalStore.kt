package cn.replyassistant.data

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import cn.replyassistant.domain.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Whole archive snapshots are committed atomically; all UI/service writes go through one controller. */
class LocalStore(context: Context, databaseName: String = "assistant.db") : SQLiteOpenHelper(context, databaseName, null, 1) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE archives(id TEXT PRIMARY KEY, body TEXT NOT NULL)")
        db.execSQL("CREATE TABLE session(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)")
    }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) { error("不支持的数据库版本") }
    fun archives(): List<ChatArchive> = readableDatabase.rawQuery("SELECT body FROM archives", null).use { cursor ->
        buildList { while (cursor.moveToNext()) add(json.decodeFromString<ChatArchive>(cursor.getString(0))) }
    }
    fun session(): PreviewSession? = readableDatabase.rawQuery("SELECT body FROM session WHERE id=1", null).use {
        if (it.moveToFirst()) json.decodeFromString<PreviewSession>(it.getString(0)) else null
    }
    @Synchronized fun save(archives: List<ChatArchive>, session: PreviewSession?) {
        writableDatabase.apply {
            beginTransaction()
            try {
                delete("archives", null, null)
                archives.forEach { archive -> insertOrThrow("archives", null, ContentValues().apply {
                    put("id", archive.id); put("body", json.encodeToString(archive))
                }) }
                delete("session", null, null)
                session?.let { insertOrThrow("session", null, ContentValues().apply { put("id", 1); put("body", json.encodeToString(it)) }) }
                setTransactionSuccessful()
            } finally { endTransaction() }
        }
    }
}
