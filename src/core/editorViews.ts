// Which main view is open and where the document view continues (framework-free, ADR-004).
// Every way between the views passes through here, so they all treat the page the same.

export type MainView = 'document' | 'pages' | 'sourceText' | 'table'
export type DocumentDialog = 'info' | 'labels' | 'ocr'

export class EditorViews {
  main: MainView = 'document'
  dialog: DocumentDialog | null = null
  searchOpen = false
  /** Page shown when the document view was left, then the page shown in the other view:
   * those views open there, and the document view returns to it. Never a reason to re-render. */
  viewedPage = 0
  /** The document view still has to scroll there. */
  returnPage: number | null = null
  private listeners = new Set<() => void>()
  private version = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getVersion = (): number => this.version

  private changed() {
    this.version += 1
    this.listeners.forEach(listener => listener())
  }

  private go(main: MainView, visiblePage: number) {
    if (this.main === 'document' && main !== 'document') this.viewedPage = visiblePage
    if (this.main !== 'document' && main === 'document') this.returnPage = this.viewedPage
    this.main = main
  }

  private toggle(main: MainView, visiblePage: number) {
    this.go(this.main === main ? 'document' : main, visiblePage)
    this.dialog = null
    this.searchOpen = false
    this.changed()
  }

  togglePages(visiblePage: number) { this.toggle('pages', visiblePage) }
  toggleSourceText(visiblePage: number) { this.toggle('sourceText', visiblePage) }
  openTable(visiblePage: number) { this.toggle(this.main === 'table' ? 'document' : 'table', visiblePage) }

  /** The table or text correction asks to be closed. */
  closeMain() {
    this.go('document', this.viewedPage)
    this.changed()
  }

  /** Document info opens over any view. The others work on the document view. */
  openDialog(dialog: DocumentDialog, visiblePage: number) {
    if (dialog !== 'info') {
      if (this.main === 'document') this.viewedPage = visiblePage
      this.go('document', visiblePage)
    }
    this.dialog = dialog
    this.changed()
  }

  closeDialog() {
    this.dialog = null
    this.changed()
  }

  private showSearch(open: boolean, visiblePage: number) {
    this.go('document', visiblePage)
    this.dialog = null
    this.searchOpen = open
    this.changed()
  }

  toggleSearch(visiblePage: number) { this.showSearch(!this.searchOpen, visiblePage) }
  openSearch(visiblePage: number) { this.showSearch(true, visiblePage) }

  closeSearch() {
    this.searchOpen = false
    this.changed()
  }

  /** A jump to a place in the document: that place wins over the remembered page. */
  showDocument() {
    this.main = 'document'
    this.returnPage = null
    this.changed()
  }

  rememberPage(index: number) {
    this.viewedPage = index
  }

  /** The document view has reached the page. */
  returned() {
    this.returnPage = null
  }

  /** Another document was opened. */
  reset() {
    this.main = 'document'
    this.dialog = null
    this.searchOpen = false
    this.viewedPage = 0
    this.returnPage = null
    this.changed()
  }
}
