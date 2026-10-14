import { nativeDisplayFontSize } from '../core/pdf/acroForm'
import { useRef } from 'react'
import { createId } from '../core/model'
import { setNativeFieldValue, type NativeFieldValue, type NativeWidget } from '../core/forms'
import type { EditorStore } from '../core/editorStore'
function NativeControl({ field, store, interactive, zoom, onSelect, onError }: { field: NativeWidget; store: EditorStore; interactive: boolean; zoom: number; onSelect: (id: string | null) => void; onError?: (message: string) => void }) {
  const session = useRef('')
  const value = store.state.formValues?.[field.key] ?? field.value
  const disabled = !interactive || field.readOnly
  const change = (next: NativeFieldValue) => {
    try { store.dispatch(setNativeFieldValue(store.state, field, next, session.current)); }
    catch (e) { onError?.(e instanceof Error ? e.message : 'Das Formularfeld konnte nicht geändert werden.') }
  }
  const shared = {
    'aria-label': field.kind === 'radio' ? `${field.label}: ${field.option}` : field.label,
    title: `${field.label} · PDF-Formularfeld${field.readOnly ? ' · schreibgeschützt' : ''}`,
    disabled,
    onFocus: () => { session.current = createId(); onSelect(null) },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => { if (event.key === 'Escape') event.currentTarget.blur(); event.stopPropagation() },
    style: { fontSize: nativeDisplayFontSize(field, value) * zoom, textAlign: field.alignment },
  }
  return <div className="native-widget" style={{ left: field.x * zoom, top: field.y * zoom, width: field.width * zoom, height: field.height * zoom, pointerEvents: disabled ? 'none' : 'auto' }}
    onPointerDown={event => event.stopPropagation()} onDrop={event => event.stopPropagation()}>
    <div className="native-widget-content" style={{ width: field.inputWidth * zoom, height: field.inputHeight * zoom, transform: `translate(-50%,-50%) rotate(${field.rotation}deg)` }}>
    {field.kind === 'checkbox' ? <input {...shared} type="checkbox" checked={value === true} onChange={e => change(e.target.checked)} />
      : field.kind === 'radio' ? <input {...shared} type="radio" name={field.key} checked={value === field.option} onChange={() => change(field.option ?? '')} />
      : field.kind === 'choice' && !field.editable ? <select {...shared} multiple={field.multiple} value={field.multiple ? Array.isArray(value) ? value : [String(value)] : Array.isArray(value) ? value[0] ?? '' : String(value)}
          onChange={e => change(field.multiple ? Array.from(e.target.selectedOptions, option => option.value) : e.target.value)}>
          {!field.multiple && <option value="">—</option>}{field.options?.map(option => <option key={option} value={option}>{option}</option>)}
        </select>
      : field.multiline ? <textarea {...shared} maxLength={field.maxLength} value={String(value)} onChange={e => change(e.target.value)} />
      : <input {...shared} type={field.password ? 'password' : 'text'} maxLength={field.maxLength} value={Array.isArray(value) ? value[0] ?? '' : String(value)} onChange={e => change(e.target.value)} />}
    </div>
  </div>
}
export function NativeFormLayer({ fields, store, interactive, highlight, zoom, onSelect, onError }: { fields: NativeWidget[]; store: EditorStore; interactive: boolean; highlight: boolean; zoom: number; onSelect: (id: string | null) => void; onError?: (message: string) => void }) {
  return <div className={`native-form-layer${highlight && interactive ? ' highlighted' : ''}`}>
    {fields.map(field => <NativeControl key={field.id} {...{ field, store, interactive, zoom, onSelect, onError }} />)}
  </div>
}
