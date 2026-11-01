import { beforeEach, expect, test, vi } from 'vitest'
import { EditorViews } from '../../src/core/editorViews'

let views: EditorViews
beforeEach(() => { views = new EditorViews() })

test.each([
  ['page manager', (v: EditorViews, page: number) => v.togglePages(page), (v: EditorViews) => v.togglePages(0), 'pages'],
  ['text correction', (v: EditorViews, page: number) => v.toggleSourceText(page), (v: EditorViews) => v.toggleSourceText(0), 'sourceText'],
  ['table', (v: EditorViews, page: number) => v.openTable(page), (v: EditorViews) => v.closeMain(), 'table'],
] as const)('the %s opens at the visible page, and the document returns to the page last shown there', (_, open, close, main) => {
  open(views, 4)
  expect(views.main).toBe(main)
  expect(views.viewedPage).toBe(4)
  expect(views.returnPage).toBeNull()
  views.rememberPage(7)
  close(views)
  expect(views.main).toBe('document')
  expect(views.returnPage).toBe(7)
})

test('there is only one main view, and switching keeps the page', () => {
  views.togglePages(2)
  views.rememberPage(5)
  views.toggleSourceText(0)
  expect(views.main).toBe('sourceText')
  expect(views.viewedPage).toBe(5)
  expect(views.returnPage).toBeNull()
})

test.each([
  ['the button', (v: EditorViews) => v.toggleSearch(0)],
  ['the shortcut', (v: EditorViews) => v.openSearch(0)],
] as const)('search through %s leaves every other view and returns to the page', (_, search) => {
  for (const open of [(page: number) => views.togglePages(page), (page: number) => views.openTable(page)]) {
    views = new EditorViews()
    open(3)
    search(views)
    expect(views).toMatchObject({ main: 'document', searchOpen: true, returnPage: 3 })
  }
})

test('the shortcut keeps search open, the button closes it', () => {
  views.openSearch(0)
  views.openSearch(0)
  expect(views.searchOpen).toBe(true)
  views.toggleSearch(0)
  expect(views.searchOpen).toBe(false)
})

test('opening a main view closes search and dialogs', () => {
  views.openSearch(0)
  views.togglePages(0)
  expect(views.searchOpen).toBe(false)
  views.openDialog('info', 0)
  views.toggleSourceText(0)
  expect(views.dialog).toBeNull()
})

test('document info stays over the open view', () => {
  views.toggleSourceText(2)
  views.openDialog('info', 0)
  expect(views).toMatchObject({ main: 'sourceText', dialog: 'info', returnPage: null })
})

test('dialogs on the document leave the text correction and keep its page', () => {
  views.toggleSourceText(2)
  views.rememberPage(6)
  views.openDialog('ocr', 0)
  expect(views).toMatchObject({ main: 'document', dialog: 'ocr', viewedPage: 6, returnPage: 6 })
})

test('OCR opened from the document starts at the visible page', () => {
  views.openDialog('ocr', 3)
  expect(views.viewedPage).toBe(3)
  expect(views.returnPage).toBeNull()
})

test('closing the table or text correction returns to the page', () => {
  views.openTable(1)
  views.closeMain()
  expect(views).toMatchObject({ main: 'document', returnPage: 1 })
  views.returned()
  expect(views.returnPage).toBeNull()
})

test('a jump into the document wins over the remembered page', () => {
  views.togglePages(1)
  views.showDocument()
  expect(views).toMatchObject({ main: 'document', returnPage: null })
})

test('a new document starts over', () => {
  views.togglePages(4)
  views.openDialog('info', 0)
  views.reset()
  expect(views).toMatchObject({ main: 'document', dialog: null, searchOpen: false, viewedPage: 0, returnPage: null })
})

test('following the visible page does not cause a render', () => {
  const listener = vi.fn()
  views.subscribe(listener)
  views.rememberPage(3)
  expect(listener).not.toHaveBeenCalled()
  views.togglePages(0)
  expect(listener).toHaveBeenCalledOnce()
})
