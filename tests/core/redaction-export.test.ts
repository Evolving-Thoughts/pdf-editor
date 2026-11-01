import {expect,test} from 'vitest'
import { PDFDocument,StandardFonts,PDFRawStream,decodePDFRawStream } from 'pdf-lib'
import { inspectPages,composePages } from '../../src/core/pdf/pageOperations'
import { writeRasterSource } from '../../src/core/pdf/rasterSource'
// A real lossless opaque pixel; rendering/mask geometry is tested separately in Chromium.
const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'))
test('raster replacement excludes original text, widgets and metadata while retaining the other vector page',async()=>{
 const doc=await PDFDocument.create(),a=doc.addPage([400,600]),b=doc.addPage([400,600]),font=await doc.embedFont(StandardFonts.Helvetica)
 a.drawText('SECRET-ORIGINAL',{x:20,y:500,font});b.drawText('PUBLIC-PAGE',{x:20,y:500,font});doc.setTitle('SECRET-METADATA')
 const f=doc.getForm().createTextField('private');f.setText('SECRET-FIELD');f.addToPage(a,{x:20,y:400,width:200,height:25})
 const g=doc.getForm().createTextField('public');g.setText('Keep editable');g.addToPage(b,{x:20,y:400,width:200,height:25})
 const original=await doc.save(),copy=original.slice(),pages=await inspectPages(original,'fixture')
 const result=await writeRasterSource([{page:pages[0],png}])
 const out=await PDFDocument.load(await composePages(original,[result.source],[result.replacements[0],pages[1]]))
 expect(out.getPageCount()).toBe(2);expect(out.getPage(0).getWidth()).toBe(400)
 expect(out.getForm().getFields().map(f=>f.getName())).toEqual(['public'])
 expect(out.getForm().getTextField('public').getText()).toBe('Keep editable');expect(out.getTitle()).not.toBe('SECRET-METADATA')
 const streams=out.context.enumerateIndirectObjects().filter(([,o])=>o instanceof PDFRawStream).map(([,o])=>{try{return Buffer.from(decodePDFRawStream(o as PDFRawStream).decode()).toString()}catch{return ''}}).join('\n')
 expect(streams).not.toContain('SECRET');expect(streams).toContain('5055424C49432D50414745')
 expect(original).toEqual(copy)
})

test('a redacted export must not carry an unused source XObject through an unaffected page resource dictionary',async()=>{
 const doc=await PDFDocument.create();doc.addPage([400,600]);const b=doc.addPage([400,600]),font=await doc.embedFont(StandardFonts.Helvetica)
 b.drawText('PUBLIC-PAGE',{x:20,y:500,font})
 const hidden=doc.context.register(doc.context.flateStream('BT (SECRET-UNUSED) Tj ET',{Type:'XObject',Subtype:'Form',BBox:[0,0,400,600]}))
 b.node.Resources()!.set((await import('pdf-lib')).PDFName.of('XObject'),doc.context.obj({UnusedSecret:hidden}))
 const original=await doc.save(),pages=await inspectPages(original,'fixture'),result=await writeRasterSource([{page:pages[0],png}])
 const out=await PDFDocument.load(await composePages(original,[result.source],[result.replacements[0],pages[1]]))
 const streams=out.context.enumerateIndirectObjects().filter(([,o])=>o instanceof PDFRawStream).map(([,o])=>{try{return Buffer.from(decodePDFRawStream(o as PDFRawStream).decode()).toString()}catch{return ''}}).join('\n')
 expect(streams).not.toContain('SECRET-UNUSED')
 expect(streams).toContain('5055424C49432D50414745')
})

async function secureOutput(doc: PDFDocument) {
 const original=await doc.save({updateFieldAppearances:false}), pages=await inspectPages(original,'fixture')
 const result=await writeRasterSource([{page:pages[0],png}])
 return PDFDocument.load(await composePages(original,[result.source],[result.replacements[0],pages[1]]))
}
function decodedStreams(doc:PDFDocument) {
 return doc.context.enumerateIndirectObjects().filter(([,o])=>o instanceof PDFRawStream).map(([,o])=>{try{return Buffer.from(decodePDFRawStream(o as PDFRawStream).decode()).toString()}catch{return ''}}).join('\n')
}
test('links back to an omitted page and nonvisual form values cannot revive confidential objects',async()=>{
 const {PDFName}=await import('pdf-lib'),doc=await PDFDocument.create(),a=doc.addPage([400,600]),b=doc.addPage([400,600])
 a.drawText('SECRET-LINK-TARGET');b.drawText('PUBLIC-LINK-PAGE')
 const annotation=doc.context.register(doc.context.obj({Type:'Annot',Subtype:'Link',Rect:[0,0,50,50],Dest:[a.ref,'Fit'],P:b.ref,A:{S:'GoTo',D:[a.ref,'Fit']}}));b.node.addAnnot(annotation)
 doc.getForm().createTextField('hidden').setText('SECRET-HIDDEN-VALUE')
 const output=await secureOutput(doc)
 expect(decodedStreams(output)).not.toContain('SECRET');expect(output.getForm().getFields()).toHaveLength(0)
 expect(output.context.enumerateIndirectObjects().filter(([,o])=>o instanceof (doc.getPage(0).node.constructor)).length).toBe(2)
 expect(output.getPage(1).node.Annots()?.lookup(0,(await import('pdf-lib')).PDFDict).has(PDFName.of('Dest'))).toBe(false)
})
test('used nested forms stay vector-based but their unused resources are removed; strings/comments are not operators',async()=>{
 const {PDFName}=await import('pdf-lib'),doc=await PDFDocument.create();doc.addPage([400,600]);const b=doc.addPage([400,600])
 const secret=doc.context.register(doc.context.flateStream('SECRET-NESTED',{Type:'XObject',Subtype:'Form',BBox:[0,0,20,20]}))
 const form=doc.context.register(doc.context.flateStream('0 0 10 10 re f\n% /Unused Do\nBT (/Unused Do) Tj ET',{Type:'XObject',Subtype:'Form',BBox:[0,0,20,20],Resources:{XObject:{Unused:secret}}}))
 b.node.set(PDFName.of('Resources'),doc.context.obj({XObject:{Used:form,Unused:secret}}))
 b.node.set(PDFName.of('Contents'),doc.context.register(doc.context.flateStream('/Used Do')))
 const out=await secureOutput(doc),streams=decodedStreams(out)
 expect(streams).not.toContain('SECRET-NESTED');expect(streams).toContain('/Used Do');expect(streams).toContain('0 0 10 10 re f')
})
test('inline image resource syntax fails closed rather than publishing an unverified export',async()=>{
 const {PDFName}=await import('pdf-lib'),doc=await PDFDocument.create();doc.addPage([400,600]);const b=doc.addPage([400,600])
 b.node.set(PDFName.of('Contents'),doc.context.register(doc.context.flateStream('BI /W 1 /H 1 /BPC 8 /CS /RGB ID abc EI')))
 await expect(secureOutput(doc)).rejects.toThrow('nicht unterstützt')
})

test('extracting only an unaffected page from a redacted document also removes unused private resources',async()=>{
 const {PDFName}=await import('pdf-lib'),{exportPageDocument}=await import('../../src/core/pdf/pageOperations'),doc=await PDFDocument.create();doc.addPage([400,600]);const b=doc.addPage([400,600]);b.drawText('PUBLIC')
 b.node.Resources()!.set(PDFName.of('XObject'),doc.context.obj({Unused:doc.context.register(doc.context.flateStream('SECRET-SUBSET',{Type:'XObject',Subtype:'Form',BBox:[0,0,20,20]}))}))
 const original=await doc.save(),pages=await inspectPages(original,'fixture'),result=await writeRasterSource([{page:pages[0],png}])
 const output=await PDFDocument.load(await exportPageDocument(original,[result.source],[result.replacements[0],pages[1]],[],{pageId:pages[1].id}))
 expect(output.getPageCount()).toBe(1);expect(decodedStreams(output)).not.toContain('SECRET-SUBSET')
})

test('sticky secure mode remains effective when the last rasterized page was removed',async()=>{
 const {PDFName}=await import('pdf-lib'),doc=await PDFDocument.create();const a=doc.addPage([400,600]);a.drawText('PUBLIC')
 a.node.Resources()!.set(PDFName.of('XObject'),doc.context.obj({Unused:doc.context.register(doc.context.flateStream('SECRET-AFTER-DELETE',{Type:'XObject',Subtype:'Form',BBox:[0,0,20,20]}))}))
 const original=await doc.save(),pages=await inspectPages(original,'fixture')
 // This looks like an unchanged original page tree; secure mode must still bypass the fast path.
 const output=await PDFDocument.load(await composePages(original,[],pages,{secure:true}))
 expect(decodedStreams(output)).not.toContain('SECRET-AFTER-DELETE')
})

test('private auxiliary metadata on a retained public font is not copied',async()=>{
 const {PDFName}=await import('pdf-lib'),doc=await PDFDocument.create();doc.addPage([400,600]);const b=doc.addPage([400,600]),font=await doc.embedFont(StandardFonts.Helvetica)
 b.drawText('PUBLIC-FONT',{font});await doc.flush()
 const dict=doc.context.lookup(font.ref,(await import('pdf-lib')).PDFDict)
 dict.set(PDFName.of('Metadata'),doc.context.register(doc.context.flateStream('SECRET-FONT-METADATA')))
 const output=await secureOutput(doc)
 expect(decodedStreams(output)).not.toContain('SECRET-FONT-METADATA');expect(decodedStreams(output)).toContain('5055424C49432D464F4E54')
})

test('a remaining page using the same image as an omitted confidential page fails closed',async()=>{
 const doc=await PDFDocument.create(),a=doc.addPage([400,600]),b=doc.addPage([400,600]),image=await doc.embedPng(png)
 a.drawImage(image,{x:20,y:20,width:200,height:200});b.drawImage(image,{x:20,y:20,width:100,height:100})
 await expect(secureOutput(doc)).rejects.toThrow('nicht unterstützt')
})
