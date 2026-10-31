// Core module: the document as it leaves the editor. Callers hand over a snapshot of
// the editing state; which pages are secure and how they are composed is decided here.
import { copyEditorState, type EditorState } from '../model'
import { composePages, selectPages } from './pageOperations'

export interface DocumentSnapshot {
  original: Uint8Array
  state: EditorState
}

export const snapshotDocument = (original: Uint8Array, state: EditorState): DocumentSnapshot =>
  ({ original, state: copyEditorState(state) })

/** Once redacted, always secure: this holds after the rasterized pages are gone, too. */
export const isSecure = (state: EditorState) => !!state.redactionApplied || (state.pages ?? []).some(page => page.redacted)

/** Only the chosen pages. A redacted document stays secure, whatever the choice. */
export const selectDocument = ({ original, state }: DocumentSnapshot, ids: readonly string[]): DocumentSnapshot =>
  ({ original, state: { ...state, ...selectPages(state.pages ?? [], state.overlays, ids), redactionApplied: isSecure(state) } })

/** The pages as the viewer shows them. Form values and overlays stay editable on top. */
export const previewDocument = ({ original, state }: DocumentSnapshot) =>
  composePages(original, state.pageSources ?? [], state.pages ?? [], undefined, isSecure(state))
