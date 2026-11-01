import { PDFCheckBox, PDFDict, PDFDocument, PDFString, PDFHexString, layoutMultilineText, layoutSinglelineText, layoutCombedText, TextAlignment, type PDFFont, PDFDropdown, PDFName, PDFOptionList, PDFRadioGroup, PDFTextField, StandardFonts, type PDFField } from 'pdf-lib'
import { formKey, validateFieldValue, type FormValues, type NativeFieldValue, type NativeWidget } from '../forms'
import { pageSize, type DocumentPage, type PageSource } from '../pages'
let metricFont: PDFFont | undefined
let metricPromise: Promise<PDFFont> | undefined
async function ensureMetrics() {
  metricPromise ??= PDFDocument.create().then(doc => doc.embedFont(StandardFonts.Helvetica))
  metricFont = await metricPromise
}
/** Same standard-font layout as the writer for PDF fields with automatic font size. */
export function nativeDisplayFontSize(field: NativeWidget, value: NativeFieldValue) {
  if (!field.autoFont || !metricFont || field.kind !== 'text') return field.fontSize
  const unit = field.unit ?? 1, inset = (field.borderWidth ?? 0) + (field.combed ? 0 : 1)
  const bounds = { x: inset, y: inset, width: field.inputWidth / unit - 2 * inset, height: field.inputHeight / unit - 2 * inset }
  const options = { font: metricFont, fontSize: 0, bounds, alignment: TextAlignment.Left }
  try {
    const text = String(value)
    const size = field.multiline ? layoutMultilineText(text, options).fontSize : field.combed ? layoutCombedText(text, { ...options, cellCount: field.maxLength ?? 1 }).fontSize : layoutSinglelineText(text, options).fontSize
    return size * unit
  } catch { return field.fontSize } // Unsupported glyphs remain editable/savable; export explains the limitation.
}
function fieldInfo(field: PDFField) {
  const base = { readOnly: field.isReadOnly(), name: field.getName() }
  if (field instanceof PDFTextField) return { ...base, kind: 'text' as const, value: field.getText() ?? '', multiline: field.isMultiline(), password: field.isPassword(), maxLength: field.getMaxLength() }
  if (field instanceof PDFCheckBox) return { ...base, kind: 'checkbox' as const, value: field.isChecked() }
  if (field instanceof PDFRadioGroup) return { ...base, kind: 'radio' as const, value: field.getSelected() ?? '', options: field.getOptions() }
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) return { ...base, kind: 'choice' as const, value: field.getSelected(), options: field.getOptions(), multiple: field.isMultiselect(), editable: field instanceof PDFDropdown && field.isEditable() }
  return null
}
export function applyFormValues(doc: PDFDocument, sourceId: string, values: FormValues): boolean {
  let changed = false
  for (const field of doc.getForm().getFields()) {
    const key = formKey(sourceId, field.getName())
    if (!Object.hasOwn(values, key)) continue
    const info = fieldInfo(field)
    if (!info) throw new Error(`Das Formularfeld „${field.getName()}“ wird noch nicht unterstützt.`)
    const value = values[key]; validateFieldValue(info, value)
    if (field instanceof PDFTextField) field.setText(value as string)
    else if (field instanceof PDFCheckBox) { if (value) field.check(); else field.uncheck() }
    else if (field instanceof PDFRadioGroup) { if (value) field.select(value as string); else field.clear() }
    else if (field instanceof PDFDropdown || field instanceof PDFOptionList) { const selected = Array.isArray(value) ? value : value ? [value as string] : []; if (selected.length) field.select(selected); else field.clear() }
    changed = true
  }
  return changed
}
export async function updateFormAppearances(doc: PDFDocument) {
  try { doc.getForm().updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica)) }
  catch { throw new Error('Ein Formularwert kann mit der unterstützten PDF-Standardschrift nicht dargestellt werden. Bitte Sonderzeichen prüfen; der Entwurf bleibt erhalten.') }
}
function point(page: DocumentPage, x: number, y: number) {
  x = (x - page.box.x) * page.unit; y = (y - page.box.y) * page.unit
  const w = page.box.width * page.unit, h = page.box.height * page.unit
  switch (page.rotation) { case 90: return { x: y, y: w - x }; case 180: return { x: w - x, y: h - y }; case 270: return { x: h - y, y: x }; default: return { x, y } }
}
/** Missing metadata from older drafts is unknown, not proof that a source has no fields. */
export const carriesXfa = (doc: PDFDocument) => !!doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)?.has(PDFName.of('XFA'))

export const needsNativeFormInspection = (page: DocumentPage) => page.hasForms !== false || page.hasXfa === true
/** Source keys never depend on document order or collision-renamed export field names. */
export async function inspectNativeForms(original: Uint8Array, sources: PageSource[], pages: DocumentPage[]): Promise<{ widgets: NativeWidget[]; unsupported: string[] }> {
  const sourceIds = new Set(pages.filter(needsNativeFormInspection).map(page => page.sourceId))
  if (!sourceIds.size) return { widgets: [], unsupported: [] }
  await ensureMetrics()
  const widgets: NativeWidget[] = [], unsupported: string[] = []
  for (const sourceId of sourceIds) {
    const bytes = sourceId === 'original' ? original : sources.find(s => s.id === sourceId)?.bytes
    if (!bytes) throw new Error('Formular-Quelldaten fehlen.')
    const doc = await PDFDocument.load(bytes)
    if (carriesXfa(doc)) { unsupported.push('XFA-Formular'); continue }
    for (const field of doc.getForm().getFields()) {
      let info: ReturnType<typeof fieldInfo>
      try { info = fieldInfo(field) } catch { info = null }
      if (!info) { unsupported.push(field.getName()); continue }
      const appearances = field.acroField.getDefaultAppearance() ?? ''
      const match = [...appearances.matchAll(/([\d.]+)\s+Tf/g)].at(-1)
      const declaredSize = match ? Number(match[1]) : 0
      const alternateRaw = field.acroField.getInheritableAttribute(PDFName.of('TU'))
      const alternate = alternateRaw ? doc.context.lookup(alternateRaw) : undefined
      const label = alternate instanceof PDFString || alternate instanceof PDFHexString ? alternate.decodeText() : info.name
      for (const [wi, widget] of field.acroField.getWidgets().entries()) {
        if (widget.getFlags() & (1 | 2 | 32)) continue
        for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
          const plan = pages[pageIndex]
          if (plan.sourceId !== sourceId) continue
          const sourcePage = doc.getPage(plan.sourceIndex), annots = sourcePage.node.Annots()
          let present = false
          for (let i = 0; i < (annots?.size() ?? 0); i++) if (annots!.lookup(i) === widget.dict) present = true
          if (!present) continue
          const r = widget.getRectangle()
          if (r.x + r.width <= plan.box.x || r.y + r.height <= plan.box.y || r.x >= plan.box.x + plan.box.width || r.y >= plan.box.y + plan.box.height) continue
          const corners = [[r.x, r.y], [r.x + r.width, r.y], [r.x, r.y + r.height], [r.x + r.width, r.y + r.height]].map(([x, y]) => point(plan, x, y))
          const minX = Math.min(...corners.map(p => p.x)), maxX = Math.max(...corners.map(p => p.x)), minY = Math.min(...corners.map(p => p.y)), maxY = Math.max(...corners.map(p => p.y))
          const own = widget.getAppearanceCharacteristics()?.getRotation() ?? 0
          if (![0, 90, 180, 270].includes(own)) { unsupported.push(field.getName()); continue }
          const alignment = field instanceof PDFTextField ? ['left', 'center', 'right'][field.getAlignment()] as 'left' | 'center' | 'right' : 'left'
          widgets.push({ ...info, value: structuredClone(info.value) as NativeFieldValue,
            id: `${formKey(sourceId, info.name)}:${wi}:${plan.id}`, key: formKey(sourceId, info.name), label, pageIndex,
            x: minX, y: pageSize(plan).height - maxY, width: maxX - minX, height: maxY - minY,
            inputWidth: (own % 180 ? r.height : r.width) * plan.unit, inputHeight: (own % 180 ? r.width : r.height) * plan.unit,
            rotation: (plan.rotation + own) % 360,
            ...(info.kind === 'radio' ? { option: info.options[wi] } : {}),
            autoFont: declaredSize === 0, unit: plan.unit, borderWidth: widget.getBorderStyle()?.getWidth() ?? 0, combed: field instanceof PDFTextField && field.isCombed(),
            fontSize: (declaredSize || Math.min(14, r.height * .65)) * plan.unit, alignment,
          })
        }
      }
    }
  }
  return { widgets, unsupported: [...new Set(unsupported)] }
}
