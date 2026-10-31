import { collectErrors, launchBrowser } from './browser-helper.mjs'
import { PDFDocument, PDFName, PDFNumber, degrees } from 'pdf-lib'
import assert from 'node:assert/strict'
const browser=await launchBrowser()
const page=await browser.newPage(),errors=[];collectErrors(page, errors)
try {
 await page.goto(process.env.SMOKE_URL??'http://localhost:5220')
 for(const rotation of [0,90,180,270]) {
  const doc=await PDFDocument.create(),a=doc.addPage([400,600]),b=doc.addPage([400,600])
  a.drawText('SECRET-ROTATION',{x:80,y:350,size:20});a.setCropBox(50,20,300,500);a.setRotation(degrees(rotation));a.node.set(PDFName.of('UserUnit'),PDFNumber.of(2));b.drawText('PUBLIC-UNCHANGED')
  const bytes=await doc.save(),expected=rotation%180?{width:1000,height:600}:{width:600,height:1000}
  const result=await page.evaluate(async({data,expected})=>{
   const {inspectPages,exportPageDocument}=await import('/src/core/pdf/pageOperations.ts'),{prepareRedaction}=await import('/src/core/pdf/redactDocument.ts'),{loadPdf}=await import('/src/core/pdf/loadPdf.ts')
   const original=new Uint8Array(data),pages=await inspectPages(original,'rotated'),mark={id:'literal',pageId:pages[0].id,x:100,y:80,width:80,height:60,fill:'black'}
   const state={pages,pageSources:[],overlays:[],redactions:[mark]},prepared=await prepareRedaction(original,state)
   const manifest=pages.map(p=>prepared.replacements.find(r=>r.id===p.id)??p),out=await exportPageDocument(original,[prepared.source],manifest,prepared.newText)
   const pdf=await loadPdf('result',out),size=await pdf.getPageSize(1),canvas=document.createElement('canvas');await pdf.renderPage(1,canvas,1)
   const pixel=Array.from(canvas.getContext('2d').getImageData(120,expected.height-100,1,1).data)
   await pdf.destroy()
   const {getDocument,GlobalWorkerOptions}=await import('/node_modules/pdfjs-dist/build/pdf.mjs');GlobalWorkerOptions.workerSrc='/node_modules/pdfjs-dist/build/pdf.worker.min.mjs';const task=getDocument({data:out}),d=await task.promise
   const texts=[];for(let i=1;i<=2;i++)texts.push((await (await d.getPage(i)).getTextContent()).items.map(t=>t.str??'').join(' '));await task.destroy()
   const white=await prepareRedaction(original,{...state,redactions:[{...mark,x:0,y:0,width:expected.width,height:expected.height,fill:'white'}]});
   return {size,pixel,texts,newPage:prepared.replacements[0],suggestion:white.newText[0]}
  },{data:Array.from(bytes),expected})
  assert.deepEqual(result.size,expected);assert.deepEqual(result.pixel,[0,0,0,255]);assert.equal(result.texts[0],'');assert.ok(result.texts[1].includes('PUBLIC-UNCHANGED'));assert.equal(result.newPage.rotation,0);assert.equal(result.newPage.unit,1);const baselines={0:[60,660],90:[660,540],180:[540,340],270:[340,60]};assert.ok(Math.abs(result.suggestion.x-baselines[rotation][0])<.01);assert.ok(Math.abs(result.suggestion.y-baselines[rotation][1])<.01);assert.ok(Math.abs(result.suggestion.fontSize-40)<.01);assert.ok(Math.abs((result.suggestion.rotation+360)%360-rotation)<.01)
 }
 // Unsupported resource syntax must fail before publishing a command, not after replacing pages.
 const unsupported=await PDFDocument.create();unsupported.addPage([400,600]);const other=unsupported.addPage([400,600]);other.node.set(PDFName.of('Contents'),unsupported.context.register(unsupported.context.flateStream('BI /W 1 /H 1 /BPC 8 /CS /RGB ID abc EI')))
 const failure=await page.evaluate(async data=>{
  const {inspectPages}=await import('/src/core/pdf/pageOperations.ts'),{prepareRedaction}=await import('/src/core/pdf/redactDocument.ts');const original=new Uint8Array(data),pages=await inspectPages(original,'unsafe');const state={pages,overlays:[],redactions:[{id:'one',pageId:pages[0].id,x:10,y:10,width:20,height:20,fill:'black'}]},before=JSON.stringify(state)
  try{await prepareRedaction(original,state);return {error:false}}catch(e){return {error:String(e),unchanged:before===JSON.stringify(state)}}
 },Array.from(await unsupported.save()))
 assert.ok(failure.error.includes('nicht unterstützt'));assert.equal(failure.unchanged,true)
 const huge=await PDFDocument.create();huge.addPage([3000,3000])
 const budget=await page.evaluate(async data=>{
  const {inspectPages}=await import('/src/core/pdf/pageOperations.ts'),{prepareRedaction}=await import('/src/core/pdf/redactDocument.ts');const original=new Uint8Array(data),pages=await inspectPages(original,'huge'),state={pages,overlays:[],redactions:[{id:'one',pageId:pages[0].id,x:10,y:10,width:20,height:20,fill:'black'}]},before=JSON.stringify(state);try{await prepareRedaction(original,state);return {error:false}}catch(e){return {error:String(e),unchanged:before===JSON.stringify(state)}}
 },Array.from(await huge.save()))
 assert.ok(budget.error.includes('zu groß'));assert.equal(budget.unchanged,true);assert.deepEqual(errors,[])
 console.log('PASS 0/90/180/270 rotation + nonzero crop origin + UserUnit 2: literal output dimensions, opaque mask pixels, no original text, untouched vector page; unsupported inline-image source and oversized 300-dpi page fail atomically.')
} finally {await browser.close()}
