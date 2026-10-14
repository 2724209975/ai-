package cn.replyassistant.domain

import java.text.Normalizer

/** Align a uniquely supported contiguous dialogue window, never globally distinct() text. */
object ScreenshotStitcher {
    data class Result(val messages:List<ChatMessage>,val anchors:Int=0,val newTail:List<ChatMessage> = emptyList())
    private fun key(m:ChatMessage)=m.speaker to Normalizer.normalize(m.text,Normalizer.Form.NFKC).replace(Regex("\\s+")," ").trim()
    private fun same(a:ChatMessage,b:ChatMessage)=key(a)==key(b)&&(a.timestamp==null||b.timestamp==null||a.timestamp==b.timestamp)
    private fun note(m:ChatMessage)=m.origin==Origin.SCREENSHOT&&m.speaker==Speaker.UNKNOWN&&m.text.startsWith("[图片内容，发言归属不确定]")
    private fun certain(m:ChatMessage)=!m.uncertain&&m.speaker!=Speaker.UNKNOWN
    fun merge(existing:List<ChatMessage>,incoming:List<ChatMessage>):Result {
        if(incoming.isEmpty())return Result(existing)
        if(existing.isEmpty())return Result(incoming,newTail=incoming)
        val a=existing.filterNot(::note);val b=incoming.filterNot(::note)
        if(b.isEmpty())return Result(existing+incoming)
        val index=a.withIndex().groupBy {key(it.value)}
        val shifts=mutableSetOf<Int>()
        for((j,row) in b.withIndex())if(certain(row))for(i in index[key(row)].orEmpty()) {
            if(certain(i.value)&&same(i.value,row))shifts+=i.index-j
            if(shifts.size>4096)return Result(existing+incoming.map {it.copy(orderUncertain=true)})
        }
        val valid=shifts.mapNotNull {shift->
            val start=maxOf(0,shift);val end=minOf(a.size,shift+b.size)
            if(start>=end)return@mapNotNull null
            val pairs=(start until end).map {i->a[i] to b[i-shift]}
            if(pairs.any { !same(it.first,it.second) })return@mapNotNull null
            val anchors=pairs.filter {certain(it.first)&&certain(it.second)}
            val distinct=anchors.map {key(it.first)}.distinct()
            val timed=anchors.size==1&&anchors[0].first.timestamp!=null&&anchors[0].first.timestamp==anchors[0].second.timestamp
            val supported=anchors.size>=2&&distinct.size>=2&&distinct.sumOf {it.second.length}>=12
            if(!timed&&!supported)return@mapNotNull null
            Triple(shift,anchors.size,end-start)
        }
        // Several equally supported placements are ambiguous, even when the text is identical.
        val strongest=valid.maxOfOrNull {it.second}?:0
        val candidates=valid.filter {it.second==strongest}
        if(candidates.size!=1)return Result(existing+incoming.map {if(shifts.isNotEmpty())it.copy(orderUncertain=true) else it},newTail=incoming)
        val (shift,anchorCount,_)=candidates.single()
        val aliases=mutableMapOf<String,String>();val result=mutableListOf<ChatMessage>()
        for(position in minOf(0,shift) until maxOf(a.size,shift+b.size)) {
            val old=a.getOrNull(position);val fresh=b.getOrNull(position-shift)
            if(old!=null&&fresh!=null){aliases[fresh.id]=old.id;result+=old.copy(styleExample=old.styleExample||fresh.styleExample,sourceRefs=(old.sourceRefs+fresh.sourceId+fresh.id+fresh.sourceRefs).filter {it!=old.sourceId&&it!=old.id}.distinct().takeLast(32))}
            else result+=old?:fresh!!
        }
        // Page-level picture notes are not an extra spoken message at the end of the dialogue.
        // Keep their content and attach it to the preceding utterance; do not use it as an anchor.
        val notes=mutableMapOf<String,MutableList<ChatMessage>>()
        fun attach(rows:List<ChatMessage>){var anchor="head";for(row in rows){if(!note(row)){anchor=aliases[row.id]?:row.id;continue}
            val at=notes.getOrPut(anchor){mutableListOf()};val known=at.indexOfFirst {same(it,row)}
            if(known<0)at+=row else {val old=at[known];at[known]=old.copy(sourceRefs=(old.sourceRefs+row.sourceId+row.id+row.sourceRefs).filter {it!=old.sourceId&&it!=old.id}.distinct().takeLast(32))}
        }}
        attach(existing);attach(incoming)
        val merged=notes["head"].orEmpty()+result.flatMap {listOf(it)+notes[it.id].orEmpty()}
        val tail=if(shift+b.size>a.size)b.drop(maxOf(0,a.size-shift)) else emptyList()
        return Result(merged,anchorCount,tail)
    }
    /** Replay original screenshot batches for a reviewable legacy repair. */
    fun repair(rows:List<ChatMessage>):List<ChatMessage> {
        var result=emptyList<ChatMessage>();var offset=0
        while(offset<rows.size){val first=rows[offset];var end=offset+1
            while(end<rows.size&&rows[end].sourceId==first.sourceId&&rows[end].origin==first.origin)end++
            val batch=rows.subList(offset,end)
            result=if(first.origin==Origin.SCREENSHOT)merge(result,batch).messages else result+batch
            offset=end
        }
        return result
    }
}
