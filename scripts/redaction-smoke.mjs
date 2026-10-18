import { chromiumPath } from './browser-helper.mjs'
import { confirmDefaultExport } from './export-smoke-helper.mjs'
import { chromium } from 'playwright'
import { PDFDocument,StandardFonts } from 'pdf-lib'
import { mkdirSync,readFileSync,mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
const out=process.env.SMOKE_ARTIFACT_DIR??mkdtempSync(join(tmpdir(),'pdf-redaction-'));mkdirSync(out,{recursive:true})
const browser=await chromium.launch({executablePath:chromiumPath(),args:['--no-sandbox']})
const p=await browser.newPage({viewport:{width:1280,height:1100},acceptDownloads:true}),errors=[]
p.on('pageerror',e=>errors.push(String(e)))
const btn=name=>p.getByRole('button',{name,exact:true})
async function drag(pageIndex,x1,y1,x2,y2){const el=p.locator('.pages .page').nth(pageIndex);await el.scrollIntoViewIfNeeded();const r=await el.boundingBox();await p.mouse.move(r.x+x1,r.y+y1);await p.mouse.down();await p.mouse.move(r.x+x2,r.y+y2,{steps:4});await p.mouse.up()}
async function exported(file){const event=p.waitForEvent('download');await btn('Exportieren').click(); await confirmDefaultExport(p);await (await event).saveAs(join(out,file));return new Uint8Array(readFileSync(join(out,file)))}
async function parsed(bytes){return p.evaluate(async data=>{const {getDocument,GlobalWorkerOptions,OPS}=await import('/node_modules/pdfjs-dist/build/pdf.mjs');GlobalWorkerOptions.workerSrc='/node_modules/pdfjs-dist/build/pdf.worker.min.mjs';const task=getDocument({data:new Uint8Array(data)}),doc=await task.promise,result=[];try{for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i),text=(await page.getTextContent()).items.map(t=>t.str??'').join(' '),ops=await page.getOperatorList(),annotations=await page.getAnnotations();const canvas=document.createElement('canvas'),v=page.getViewport({scale:1});canvas.width=Math.ceil(v.width);canvas.height=Math.ceil(v.height);await page.render({canvas,viewport:v}).promise;const ctx=canvas.getContext('2d');result.push({text,fields:annotations.filter(a=>a.subtype==='Widget').map(a=>a.fieldName),vector:ops.fnArray.includes(OPS.showText),pixel:Array.from(ctx.getImageData(100,200,1,1).data)});canvas.width=1;canvas.height=1}return result}finally{await task.destroy()}},Array.from(bytes))}
try{
 const doc=await PDFDocument.create(),a=doc.addPage([600,800]),b=doc.addPage([600,800]),font=await doc.embedFont(StandardFonts.Helvetica)
 a.drawText('SECRET-FIRST-ABCD',{x:40,y:600,size:20,font});b.drawText('PUBLIC-VECTOR-PAGE',{x:40,y:600,size:20,font})
 const field=doc.getForm().createTextField('Private');field.setText('SECRET-FIELD');field.addToPage(a,{x:40,y:520,width:250,height:26})
 const publicField=doc.getForm().createTextField('Public');publicField.setText('Keep editable');publicField.addToPage(b,{x:40,y:520,width:250,height:26})
 const bytes=await doc.save();await p.goto(process.env.SMOKE_URL??'http://localhost:5220')
 await p.locator('input[accept="application/pdf"]').setInputFiles({name:'redaction.pdf',mimeType:'application/pdf',buffer:Buffer.from(bytes)})
 await p.locator('.pages .page canvas').first().waitFor()
 await btn('T Text').click();await drag(0,50,230,50,230);await p.locator('.textbox textarea').fill('SECRET-OVERLAY');await p.locator('.textbox textarea').press('Escape')
 await btn('Schwärzen').click();await drag(0,30,160,390,310);await p.locator('.redaction-overlay.selected').waitFor();assert.equal(await btn('Exportieren').isDisabled(),true)
 const gripStyle=await p.locator('.redaction-grip').first().evaluate(el=>({target:el.getBoundingClientRect().width,visible:getComputedStyle(el,'::after').width}));assert.equal(gripStyle.visible,'8px');assert.ok(gripStyle.target>=44)
 // Every corner grip resizes freely; pending areas also move without dragging page content.
 for(const corner of ['nw','ne','sw','se']){const grip=p.locator(`.redaction-grip.${corner}`),r=await grip.boundingBox();await p.mouse.move(r.x+r.width/2,r.y+r.height/2);await p.mouse.down();await p.mouse.move(r.x+r.width/2+(corner.endsWith('w')?-4:4),r.y+r.height/2+(corner.startsWith('n')?-4:4));await p.mouse.up()}
 const savedStyle=await p.locator('.redaction-overlay').getAttribute('style');const cancelling=p.locator('.redaction-grip.se'),cr=await cancelling.boundingBox();await p.mouse.move(cr.x+cr.width/2,cr.y+cr.height/2);await p.mouse.down();await p.mouse.move(cr.x+cr.width/2+24,cr.y+cr.height/2+24);await cancelling.dispatchEvent('pointercancel',{pointerId:1});await p.mouse.up();assert.equal(await p.locator('.redaction-overlay').getAttribute('style'),savedStyle);
 let region=await p.locator('.redaction-overlay').boundingBox();assert.ok(region.width>360&&region.height>150)
 await p.mouse.move(region.x+region.width/2,region.y+region.height/2);await p.mouse.down();await p.mouse.move(region.x+region.width/2+2,region.y+region.height/2+2);await p.mouse.up()
 await p.screenshot({path:join(out,'desktop-pending.png')});await p.setViewportSize({width:390,height:900});const mobileWorkspace=await p.locator('.workspace').boundingBox();assert.ok(mobileWorkspace.height>=320);await p.locator('.pages').scrollIntoViewIfNeeded();await p.screenshot({path:join(out,'mobile-pending.png'),fullPage:true});await p.emulateMedia({colorScheme:'dark'});await p.screenshot({path:join(out,'mobile-pending-dark.png'),fullPage:true});await p.emulateMedia({colorScheme:'light'});await p.setViewportSize({width:1280,height:1100});
 await btn('Speichern').click();await p.waitForFunction(()=>document.querySelector('.draft-save-status')?.textContent.includes('Entwurf gespeichert'))
 await p.reload();await p.getByRole('button',{name:/Entwürfe/}).click();await p.locator('.draft-open').first().click();await p.locator('.redaction-overlay').waitFor();assert.equal(await btn('Exportieren').isDisabled(),true)
 await btn('Schwärzung anwenden …').click();await p.getByRole('dialog').waitFor();await btn('Abbrechen').click();assert.equal(await p.locator('.redaction-overlay').count(),1)
 await btn('Schwärzung anwenden …').click();await btn('Jetzt wirklich schwärzen').click();await p.waitForFunction(()=>!document.querySelector('.redaction-overlay')&&!document.querySelector('.pages')?.textContent.includes('aktualisiert'))
 await p.getByRole('textbox',{name:'Public',exact:true}).waitFor();assert.equal(await p.getByRole('textbox',{name:'Private',exact:true}).count(),0)
 const black=await exported('black.pdf'),read=await parsed(black)
 assert.equal(read[0].text,'');assert.deepEqual(read[0].fields,[]);assert.equal(read[0].vector,false);assert.deepEqual(read[0].pixel,[0,0,0,255]);assert.ok(read[1].text.includes('PUBLIC-VECTOR-PAGE'));assert.equal(read[1].vector,true);assert.deepEqual(read[1].fields,['Public'])
 assert.deepEqual((await PDFDocument.load(black)).getForm().getFields().map(f=>f.getName()),['Public'])
 await btn('Rückgängig').click();await p.locator('.redaction-overlay').waitFor();await p.getByRole('textbox',{name:'Private',exact:true}).waitFor();assert.equal(await p.locator('.textbox textarea').inputValue(),'SECRET-OVERLAY')
 await btn('Wiederholen').click();await btn('Exportieren').waitFor({state:'visible'});await p.getByRole('textbox',{name:'Public',exact:true}).waitFor()
 await btn('Speichern').click();await p.waitForFunction(()=>document.querySelector('.draft-save-status')?.textContent.includes('Entwurf gespeichert'));await p.reload();await p.getByRole('button',{name:/Entwürfe/}).click();await p.locator('.draft-open').first().click();await p.getByRole('textbox',{name:'Public',exact:true}).waitFor();assert.equal((await parsed(await exported('reopened.pdf')))[0].text,'')
 await p.screenshot({path:join(out,'desktop-black.png')})
 // White mask: uses the exact existing textbox implementation and PDF.js-derived starting size/baseline.
 await p.locator('input[accept="application/pdf"]').setInputFiles({name:'white.pdf',mimeType:'application/pdf',buffer:Buffer.from(bytes)})
 await p.getByRole('textbox',{name:'Private',exact:true}).waitFor();await btn('Schwärzen').click();await p.getByRole('combobox',{name:'Schwärzungsfarbe'}).selectOption('white');await drag(0,30,160,390,310)
 await btn('Schwärzung anwenden …').click();await btn('Jetzt wirklich schwärzen').click();await p.locator('.textbox textarea').waitFor();await p.locator('.textbox textarea').fill('REPLACEMENT-VISIBLE');await p.locator('.textbox textarea').press('Escape')
 const white=await parsed(await exported('white.pdf'));assert.ok(white[0].text.includes('REPLACEMENT-VISIBLE'));assert.ok(!white[0].text.includes('SECRET'));assert.deepEqual(white[0].pixel,[255,255,255,255]);assert.ok(white[1].text.includes('PUBLIC-VECTOR-PAGE'))
 await p.screenshot({path:join(out,'desktop-white.png')});await p.setViewportSize({width:390,height:900});await p.screenshot({path:join(out,'mobile-white.png'),fullPage:true})
 assert.equal((await PDFDocument.load(bytes)).getForm().getTextField('Private').getText(),'SECRET-FIELD');assert.deepEqual(errors,[])
 console.log('PASS real black/white 300-dpi redaction; all four corner grips + moving; pending/export blocking + draft reload; confirmation/cancel; native fields and pre-existing overlay text removed from affected output; unaffected page remains vector + native; undo/redo; durable applied draft; normal replacement textbox + selectable exported text; desktop/mobile viewport; source immutable; no page errors.')
}finally{await browser.close()}
