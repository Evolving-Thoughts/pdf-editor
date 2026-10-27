import { expect, test } from 'vitest'
import { directSelection, selectedReplacement } from '../../src/core/sourceText/directSelection'
import type { SimpleSourceRun } from '../../src/core/sourceText/simplePdf'
const make=(id:string,text:string,groupId?:string):SimpleSourceRun=>({id,text,pageIndex:0,fontName:'Helvetica',fontSize:12,x:50,baseline:700,width:100,selection:{characters:[...text].map((_,i)=>({offset:i*6,width:6})),groupId}})
const a=make('a','Grüße Welt','g'),b=make('b','Hallo Ende.','g'),c=make('c','Next paragraph')
a.paragraph=b.paragraph={text:a.text+' '+b.text,lineCount:2,leading:20,width:100}
const runs=[a,b,c]
test('partial DE/EN selection preserves unselected text',()=>{const s=directSelection(runs,'a',6,'a',10)!;expect(s.text).toBe('Welt');expect(selectedReplacement(a,s,'Erde',false)).toBe('Grüße Erde')})
test('whole run click and proved cross-line selection',()=>{expect(directSelection(runs,'c',0)?.text).toBe(c.text);const s=directSelection(runs,'a',6,'b',5)!;expect(s.text).toBe('Welt Hallo');expect(s.requiresReflow).toBe(true);expect(selectedReplacement(a,s,'Erde',true)).toBe('Grüße Erde Ende.');expect(()=>selectedReplacement(a,s,'Erde',false)).toThrow()})
test('partial selection may reflow only a proved paragraph',()=>{const s=directSelection(runs,'b',0,'b',5)!;expect(selectedReplacement(b,s,'Guten Tag',true)).toBe('Grüße Welt Guten Tag Ende.')})
test('independent fragments, unproved text and cross-paragraph selections fail closed',()=>{expect(directSelection(runs,'b',0,'c',3)).toBeNull();expect(directSelection([{...a,selection:undefined}],'a',0)).toBeNull();expect(directSelection([make('x','One'),make('y','Two')],'x',0,'y',3)).toBeNull()})
test('invalid, backward, empty, whitespace and inconsistent group mappings fail closed',()=>{for(const [from,to] of [[-1,2],[3,2],[2,2],[0,100],[0,NaN],[.5,3]])expect(directSelection(runs,'a',from,'a',to)).toBeNull();expect(directSelection(runs,'b',0,'a',3)).toBeNull();expect(directSelection(runs,'a',5,'a',6)).toBeNull();expect(directSelection([a,{...b,text:'Different'}],'a',0)).toBeNull()})
test('replacement is bound to selected run and cannot invent paragraph support',()=>{const s=directSelection(runs,'c',0)!;expect(()=>selectedReplacement(a,s,'Oops',false)).toThrow();expect(()=>selectedReplacement(c,s,'Oops',true)).toThrow()})
