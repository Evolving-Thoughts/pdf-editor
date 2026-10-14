import { describe, it, expect } from 'vitest'
import { searchDocument, type SearchFragment } from '../src/core/search'
const fragment = (text: string, x = 0): SearchFragment => ({
  text,
  quad: [
    { x, y: 0 },
    { x: x + text.length * 10, y: 0 },
    { x: x + text.length * 10, y: 10 },
    { x, y: 10 },
  ],
})
describe('document search', () => {
  it('matches literal text case insensitively, never interpreting markup or regex', () => {
    const groups = [
      { pageIndex: 0, fragments: [fragment('Antrag ANTRAG <img> a.b')] },
    ]
    expect(searchDocument(groups, 'antrag')).toHaveLength(2)
    expect(searchDocument(groups, 'a.b')).toHaveLength(1)
    expect(searchDocument(groups, '<img>')).toHaveLength(1)
    expect(searchDocument(groups, '   ')).toEqual([])
  })
  it('joins PDF items and line whitespace but not pages or separate overlays', () => {
    expect(
      searchDocument(
        [
          {
            pageIndex: 0,
            fragments: [
              { ...fragment('Zum'), breakAfter: true },
              fragment('Antrag', 30),
            ],
          },
        ],
        'Zum Antrag',
      ),
    ).toEqual([
      {
        pageIndex: 0,
        polygons: [
          [
            { x: 0, y: 0 },
            { x: 30, y: 0 },
            { x: 30, y: 10 },
            { x: 0, y: 10 },
          ],
          [
            { x: 30, y: 0 },
            { x: 90, y: 0 },
            { x: 90, y: 10 },
            { x: 30, y: 10 },
          ],
        ],
      },
    ])
    expect(
      searchDocument(
        [
          { pageIndex: 0, fragments: [fragment('Zum')] },
          { pageIndex: 0, fragments: [fragment('Antrag')] },
        ],
        'Zum Antrag',
      ),
    ).toEqual([])
  })
  it('returns partial-match geometry and document order', () => {
    const hits = searchDocument(
      [
        { pageIndex: 2, fragments: [fragment('xxAda')] },
        { pageIndex: 0, fragments: [fragment('Ada')] },
      ],
      'Ada',
    )
    expect(hits.map((h) => h.pageIndex)).toEqual([0, 2])
    expect(hits[1].polygons[0][0].x).toBe(20)
  })
  it('handles lowercase expansion without shifting subsequent geometry', () => {
    expect(
      searchDocument(
        [{ pageIndex: 0, fragments: [fragment('İ Ada')] }],
        'Ada',
      )[0].polygons[0][0].x,
    ).toBe(20)
  })
})

import { visibleFragments } from '../src/core/search'
it('excludes text outside the visible page and overlay clipping', () => {
  const visible = visibleFragments(
    [fragment('SECRET Ada')],
    { width: 100, height: 10 },
    [
      [
        { x: 70, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 10 },
        { x: 70, y: 10 },
      ],
    ],
  )
  const groups = [{ pageIndex: 0, fragments: visible }]
  expect(searchDocument(groups, 'SECRET')).toEqual([])
  expect(searchDocument(groups, 'Ada')).toHaveLength(1)
  expect(
    searchDocument(
      [
        {
          pageIndex: 0,
          fragments: visibleFragments([fragment('Ada', 200)], {
            width: 100,
            height: 10,
          }),
        },
      ],
      'Ada',
    ),
  ).toEqual([])
})
it('uses measured character advances for variable-width text', () => {
  const item = { ...fragment('Wi'), advances: [0, 0.8, 1] }
  expect(
    searchDocument([{ pageIndex: 0, fragments: [item] }], 'i')[0].polygons[0][0]
      .x,
  ).toBe(16)
})
it('retains every hit and geometry in a long item stream', () => {
  const fragments = Array.from({ length: 20000 }, (_, i) =>
    fragment('Ada ', i * 40),
  )
  const hits = searchDocument([{ pageIndex: 0, fragments }], 'Ada')
  expect(hits).toHaveLength(20000)
  expect(hits[19999].polygons[0][0].x).toBe(799960)
})
