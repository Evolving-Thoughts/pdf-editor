import { expect,test } from 'vitest'
import { createRedaction } from '../../src/core/redactions'
test('a backwards drag produces a clamped displayed-page rectangle with independent expected bounds',()=>{
 const mark=createRedaction('p',{x:300,y:400},{x:-20,y:100},{width:250,height:350},'white')
 expect(mark && [mark.pageId,mark.x,mark.y,mark.width,mark.height,mark.fill]).toEqual(['p',0,100,250,250,'white'])
})

import { moveRedaction,resizeRedaction,replaceRedactions,applyRedactionResult,validateRedactions } from '../../src/core/redactions'
import { EditorStore } from '../../src/core/editorStore'
import { type DocumentPage } from '../../src/core/pages'
const page:DocumentPage={id:'p',name:'Page',sourceId:'original',sourceIndex:0,box:{x:0,y:0,width:100,height:100},unit:1,rotation:0}
const mark={id:'r',pageId:'p',x:10,y:20,width:30,height:40,fill:'black' as const}
test('all four corner grips preserve the opposite corner; moves and crossing drags stay on-page',()=>{
 const size={width:100,height:100}
 expect(resizeRedaction(mark,'nw',-5,10,size)).toMatchObject({x:5,y:20,width:35,height:50})
 expect(resizeRedaction(mark,'ne',5,10,size)).toMatchObject({x:10,y:20,width:35,height:50})
 expect(resizeRedaction(mark,'sw',-5,-10,size)).toMatchObject({x:5,y:10,width:35,height:50})
 expect(resizeRedaction(mark,'se',5,-10,size)).toMatchObject({x:10,y:10,width:35,height:50})
 expect(resizeRedaction(mark,'nw',100,-100,size)).toMatchObject({x:38,y:20,width:2,height:2})
 expect(moveRedaction(mark,-50,500,size)).toMatchObject({x:0,y:60,width:30,height:40})
 expect(createRedaction('p',{x:1,y:1},{x:2,y:2},size,'black')).toBeNull()
 expect(()=>validateRedactions([{...mark,x:80}],[page])).toThrow(/Ungültiger/)
})
test('pending edits and applying a replacement page are atomic undoable snapshots; unaffected overlays and form values survive',()=>{
 const store=new EditorStore(),other={...page,id:'q',sourceIndex:1}
 const overlays=[{id:'private',pageIndex:0,x:1,y:20,text:'old',font:'helvetica' as const,fontSize:14,bold:false,italic:false,underline:false},{id:'public',pageIndex:1,x:1,y:20,text:'keep',font:'helvetica' as const,fontSize:14,bold:false,italic:false,underline:false}]
 store.restore(overlays,[page,other],[],{'field':'native'})
 const input=[mark];store.dispatch(replaceRedactions(store.state,input));input[0]={...mark,x:70};store.undo();store.redo();expect(store.state.redactions![0].x).toBe(10)
 const raster={...page,sourceId:'raster',redacted:true,hasForms:false},source={id:'raster',bytes:new Uint8Array([1]).buffer}
 store.dispatch(applyRedactionResult(store.state,source,[raster],[]))
 expect(store.state.pages?.[0].redacted).toBe(true);expect(store.state.overlays.map(o=>o.id)).toEqual(['public']);expect(store.state.redactions).toEqual([]);expect(store.state.formValues).toEqual({'field':'native'})
 store.undo();expect(store.state.pages?.[0].sourceId).toBe('original');expect(store.state.redactions).toEqual([mark]);expect(store.state.overlays).toEqual(overlays)
 store.redo();expect(store.state.pages?.[0].redacted).toBe(true)
})
