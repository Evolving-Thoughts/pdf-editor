import type { Command } from './commands'
import type { EditorState } from './model'
export type NativeFieldValue = string | boolean | string[]
export type FormValues = Record<string, NativeFieldValue>
export interface NativeWidget {
  id: string
  key: string
  name: string
  label: string
  kind: 'text' | 'checkbox' | 'radio' | 'choice'
  value: NativeFieldValue
  pageIndex: number
  x: number; y: number; width: number; height: number
  inputWidth: number; inputHeight: number; rotation: number
  readOnly: boolean
  multiline?: boolean; password?: boolean; maxLength?: number
  options?: string[]; option?: string; editable?: boolean; multiple?: boolean
  autoFont?: boolean; unit?: number; borderWidth?: number; combed?: boolean
  fontSize: number; alignment: 'left' | 'center' | 'right'
}
export const formKey = (source: string, name: string) => JSON.stringify([source, name])
export function validateFieldValue(field: Pick<NativeWidget, 'kind' | 'readOnly' | 'maxLength' | 'options' | 'editable' | 'multiple'>, value: NativeFieldValue) {
  if (field.readOnly) throw new Error('Dieses PDF-Feld ist schreibgeschützt.')
  if (field.kind === 'checkbox') {
    if (typeof value !== 'boolean') throw new Error('Ungültiger Checkbox-Wert.')
  } else if (field.kind === 'text') {
    if (typeof value !== 'string' || (field.maxLength !== undefined && value.length > field.maxLength)) throw new Error('Der Text überschreitet die zulässige Feldlänge.')
  } else {
    const selected = typeof value === 'string' ? value ? [value] : [] : Array.isArray(value) ? value : null
    if (!selected || (!field.multiple && selected.length > 1) || (!field.editable && selected.some(v => !field.options?.includes(v)))) throw new Error('Ungültige Formularauswahl.')
  }
}
interface FieldCommand extends Command { edit: { key: string; session?: string; before: FormValues | undefined } }
export function setNativeFieldValue(state: EditorState, field: NativeWidget, value: NativeFieldValue, session?: string): Command {
  validateFieldValue(field, value)
  const before = state.formValues ? structuredClone(state.formValues) : undefined
  const after = { ...before, [field.key]: structuredClone(value) }
  const build = (first: FormValues | undefined): FieldCommand => ({
    label: 'Edit PDF form field', edit: { key: field.key, session, before: first },
    apply: s => { s.formValues = structuredClone(after) },
    revert: s => { s.formValues = first ? structuredClone(first) : undefined },
    merge: previous => {
      const old = previous as Partial<FieldCommand>
      return (field.kind === 'text' || field.editable) && session && old.edit?.key === field.key && old.edit.session === session ? build(old.edit.before) : null
    },
  })
  return build(before)
}
