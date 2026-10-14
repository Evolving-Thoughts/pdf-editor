import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFObjectCopier,
  PDFRef, PDFString,
} from 'pdf-lib'

/** Drop only widgets on omitted pages, retaining shared/hierarchical fields. */
export function retainPageWidgets(source: PDFDocument, indices: Set<number>) {
  const sourcePages = source.getPages()
  const form = source.getForm()
  for (const field of form.getFields()) {
    const widgets = field.acroField.getWidgets()
    // Nonvisual value/calculation fields are not deleted just because they have no widget.
    if (!widgets.length || widgets.every(widget => {
      const ref = source.context.getObjectRef(widget.dict)
      return widget.dict.get(PDFName.of('Subtype'))?.toString() !== '/Widget' &&
        !sourcePages.some(p => ref && p.node.Annots()?.indexOf(ref) !== undefined)
    })) continue
    for (let i = widgets.length - 1; i >= 0; i--) {
      const widget = widgets[i]
      const ref = source.context.getObjectRef(widget.dict)
      // Annots is authoritative; /P is optional and may be missing in real PDFs.
      const pageIndex = sourcePages.findIndex(p => ref && p.node.Annots()?.indexOf(ref) !== undefined)
      if (pageIndex >= 0 && indices.has(pageIndex)) {
        widget.dict.set(PDFName.of('P'), sourcePages[pageIndex].ref)
      } else {
        if (ref && pageIndex >= 0) sourcePages[pageIndex].node.removeAnnot(ref)
        field.acroField.removeWidget(i)
      }
    }
    if (!field.acroField.getWidgets().length) form.acroForm.removeField(field.acroField)
  }
}

/** Every source uses its own font/resource names, including default appearances. */
export function namespaceFormResources(source: PDFDocument, prefix: string) {
  const root = source.getForm().acroForm.dict
  const existing = root.lookupMaybe(PDFName.of('DR'), PDFDict)
  if (!existing) return
  // DR can share dictionaries with page/appearance resources. Never rename those.
  const resources = existing.clone(source.context)
  root.set(PDFName.of('DR'), resources)
  const names = new Map<string, string>()
  for (const [categoryName, raw] of resources.entries()) {
    const oldCategory = source.context.lookup(raw)
    if (!(oldCategory instanceof PDFDict)) continue
    const category = oldCategory.clone(source.context)
    resources.set(categoryName, category)
    for (const [key, value] of category.entries()) {
      const renamed = PDFName.of(`${prefix}_${key.decodeText()}`)
      names.set(key.toString(), renamed.toString())
      category.delete(key)
      category.set(renamed, value)
    }
  }
  const rewrite = (dict: PDFDict) => {
    const appearance = dict.lookup(PDFName.of('DA'))
    if (!(appearance instanceof PDFString) && !(appearance instanceof PDFHexString)) return
    dict.set(PDFName.of('DA'), PDFString.of(appearance.decodeText().replace(/\/[^\s<>[\](){}%/]+/g,
      token => names.get(token) ?? token)))
  }
  rewrite(root)
  for (const [field] of source.getForm().acroForm.getAllFields()) rewrite(field.dict)
  for (const field of source.getForm().getFields())
    for (const widget of field.acroField.getWidgets()) rewrite(widget.dict)
}

/** Use the SAME copier as the pages: field/widget /P refs then point at real pages. */
export function mergeAcroForm(source: PDFDocument, output: PDFDocument, copier: PDFObjectCopier) {
  const sourceForm = source.getForm().acroForm
  const fields = sourceForm.Fields()
  if (!fields?.size()) return
  const destination = output.getForm().acroForm
  if (sourceForm.dict.get(PDFName.of('NeedAppearances'))?.toString() === 'true')
    destination.dict.set(PDFName.of('NeedAppearances'), sourceForm.dict.get(PDFName.of('NeedAppearances'))!)
  const root = destination.dict
  const used = new Set(destination.getFields().map(([field]) => field.getPartialName()))
  for (let i = 0; i < fields.size(); i++) {
    const ref = copier.copy(fields.get(i)) as PDFRef
    const field = output.context.lookup(ref, PDFDict)
    const title = field.lookup(PDFName.of('T'))
    const name = title instanceof PDFString || title instanceof PDFHexString ? title.decodeText() : 'Feld'
    let unique = name, suffix = 2
    while (used.has(unique)) unique = `${name}_${suffix++}`
    if (unique !== name) field.set(PDFName.of('T'), PDFString.of(unique))
    used.add(unique)
    // Root defaults cannot be shared between donor forms. Inherit them per subtree.
    for (const key of ['DA', 'Q']) {
      const value = sourceForm.dict.get(PDFName.of(key))
      if (value && !field.has(PDFName.of(key))) field.set(PDFName.of(key), copier.copy(value))
    }
    destination.addField(ref)
  }
  const resources = sourceForm.dict.lookupMaybe(PDFName.of('DR'), PDFDict)
  if (resources) {
    let merged = root.lookupMaybe(PDFName.of('DR'), PDFDict)
    if (!merged) { merged = output.context.obj({}); root.set(PDFName.of('DR'), merged) }
    for (const [key, raw] of resources.entries()) {
      const category = source.context.lookup(raw)
      if (!(category instanceof PDFDict)) continue
      let target = merged.lookupMaybe(key, PDFDict)
      if (!target) { target = output.context.obj({}); merged.set(key, target) }
      for (const [name, value] of category.entries()) target.set(name, copier.copy(value))
    }
  }
  const calculations = sourceForm.dict.lookupMaybe(PDFName.of('CO'), PDFArray)
  if (calculations) {
    let target = root.lookupMaybe(PDFName.of('CO'), PDFArray)
    if (!target) { target = output.context.obj([]); root.set(PDFName.of('CO'), target) }
    const retained = new Set(sourceForm.getAllFields().map(([, ref]) => ref))
    for (let i = 0; i < calculations.size(); i++) {
      const ref = calculations.get(i)
      if (ref instanceof PDFRef && retained.has(ref)) target.push(copier.copy(ref))
    }
  }
}
