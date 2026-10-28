// Direct native mouse selection must bind to proved source characters, not search text.
import { chromium } from 'playwright'
import { chromiumPath } from './browser-helper.mjs'
import { confirmDefaultExport } from './export-smoke-helper.mjs'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { applyButton, caret, checkInPdf, inlineInput } from './source-inline-helper.mjs'
const artifacts=process.env.SMOKE_ARTIFACT_DIR??'/tmp/pdf-editor-direct-selection'
mkdirSync(artifacts,{recursive:true})
const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica)
const p=doc.addPage([600,800])
p.drawText('Hallo Welt Grüße München.',{font,size:12,x:60,y:700})
p.drawText('Following paragraph remains fixed.',{font,size:12,x:60,y:640})
// Native CropBox origin is not (0,0); overlay must use PDF.js source transform.
p.setCropBox(20,30,550,750)
const second=doc.addPage([600,800])
second.drawText('Safe fragment for correction.',{font,size:12,x:60,y:700})
// This non-identity text matrix is displayed, but not editable by the adapter.
second.drawText('Skewed unproved text.',{font,size:12,x:60,y:600,xSkew:{type:'degrees',angle:10}})
const input=Buffer.from(await doc.save())
const browser=await chromium.launch({executablePath:chromiumPath(),args:['--no-sandbox']})
const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true})
const errors=[];page.on('pageerror',e=>errors.push(String(e)))
const editor=()=>page.locator('.source-inline')
const marked=async()=>{const [x,y]=await caret(page);return (await inlineInput(page).inputValue()).slice(x,y)}
const ready=()=>page.locator('.source-selection-layer[data-analysis-state="ready"]').waitFor()
async function drag(run,from,to){
 const a=await run.locator('span').nth(from).boundingBox(),b=await run.locator('span').nth(to-1).boundingBox()
 assert.ok(a&&b)
 await page.mouse.move(a.x+.05,a.y+a.height*.55);await page.mouse.down();await page.mouse.move(b.x+b.width-.05,b.y+b.height*.55,{steps:15});await page.mouse.up()
}
try{
 await page.goto(process.env.SMOKE_URL??'http://127.0.0.1:5237')
 await page.locator('input[accept="application/pdf"]').setInputFiles({name:'direct-selection.pdf',mimeType:'application/pdf',buffer:input})
 await page.locator('.page canvas[data-render-state="ready"]').first().waitFor()
 await page.getByRole('button',{name:'Originaltext korrigieren',exact:true}).click();await ready()
 assert.equal(await editor().count(),0,'no automatic first run selection')
 const run=page.locator('.source-run-hit').filter({hasText:'Hallo Welt Grüße München.'})
 await drag(run,6,10);await editor().waitFor()
 assert.equal(await marked(),'Welt','native mouse drag selects only the marked word in the inline editor')
 assert.equal(await inlineInput(page).evaluate(el=>el===document.activeElement),true,'inline input receives focus')
 assert.equal(await page.locator('.source-inline-selection').count(),1,'selected source word remains highlighted')
 await page.screenshot({path:artifacts+'/selection-desktop.png',fullPage:true})
 await page.keyboard.insertText('Erde')
 const next=page.locator('.source-run-hit').filter({hasText:'Following paragraph'})
 page.once('dialog',d=>d.dismiss());await next.click()
 assert.equal(await inlineInput(page).inputValue(),'Hallo Erde Grüße München.','dirty edit was not silently replaced')
 page.once('dialog',d=>d.accept());await next.click()
 assert.equal(await inlineInput(page).inputValue(),'Following paragraph remains fixed.')
 await drag(run,6,10);await page.keyboard.insertText('Erde')
 await checkInPdf(page)
 assert.equal(await page.locator('.source-selection-layer').count(),0,'candidate cannot select stale original geometry')
 await page.getByRole('button',{name:'Weiter bearbeiten',exact:true}).click();await ready()
 assert.equal(await inlineInput(page).inputValue(),'Hallo Erde Grüße München.','editing continues with the same text')
 await page.getByRole('button',{name:'Vorschau vergrößern',exact:true}).click();await ready()
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Absatz verlassen',exact:true}).click()
 await drag(run,11,16);await editor().waitFor()
 assert.equal(await marked(),'Grüße','zoom and cropped-origin mapping remain accurate')
 assert.equal(await applyButton(page).count(),0,'new selection has no candidate')
 await page.getByLabel('Seite',{exact:true}).selectOption({index:1});await ready()
 assert.equal(await editor().count(),0,'page change resets selection')
 const unproved=page.getByRole('button',{name:/Unterstützung nicht nachgewiesen: Skewed/})
 await unproved.click()
 assert.match(await page.locator('.source-editor [role="alert"]').innerText(),/nicht als sicher markierbarer/)
 assert.equal(await editor().count(),0,'unproved text never authorizes an edit')
 await page.setViewportSize({width:390,height:844})
 const safe=page.locator('.source-run-hit').filter({hasText:'Safe fragment'})
 await safe.scrollIntoViewIfNeeded();await safe.focus();await page.keyboard.press('Enter');await editor().waitFor()
 assert.equal(await inlineInput(page).inputValue(),'Safe fragment for correction.','keyboard selection works on mobile layout')
 assert.deepEqual(await caret(page),[29,29],'keyboard opens with the caret at the end')
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no mobile viewport overflow')
 await page.screenshot({path:artifacts+'/selection-mobile.png',fullPage:true})
 await page.setViewportSize({width:1440,height:1000});await page.getByLabel('Seite',{exact:true}).selectOption({index:0});await ready()
 await run.scrollIntoViewIfNeeded();await drag(run,6,10);await page.keyboard.insertText('Erde')
 await checkInPdf(page)
 await applyButton(page).click()
 await page.locator('.page canvas[data-render-state="ready"]').first().waitFor()
 const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Exportieren',exact:true}).click();await confirmDefaultExport(page)
 const dl=await pending,task=getDocument({data:Uint8Array.from(readFileSync(await dl.path())),standardFontDataUrl:resolve('node_modules/pdfjs-dist/standard_fonts')+'/'})
 try{const pdf=await task.promise,items=(await(await pdf.getPage(1)).getTextContent()).items.filter(i=>'str'in i);assert.equal(items.map(i=>i.str).filter(Boolean).join(' '),'Hallo Erde Grüße München. Following paragraph remains fixed.');assert.equal(items.at(-1).transform[5],640)}finally{await task.destroy()}
 assert.deepEqual(errors,[])
 console.log('PASS direct selection: native drag into inline editor, cropped origin, partial replacement export, focus, persistent highlight, dirty guard, unsupported text, zoom, keyboard/mobile, stale candidate')
}catch(e){console.error((await page.locator('body').innerText()).slice(-2200));await page.screenshot({path:artifacts+'/failure.png',fullPage:true});throw e}finally{await browser.close()}
