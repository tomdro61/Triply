'use client'

import React from 'react'
import { ComparisonTable } from './ComparisonTable'

// Lexical node types that Payload uses
type LexicalNode = {
  type: string
  children?: LexicalNode[]
  text?: string
  format?: number
  tag?: string
  listType?: string
  url?: string
  fields?: {
    linkType?: string
    url?: string
    newTab?: boolean
    rel?: string
  }
  html?: string
  newTab?: boolean
  src?: string
  altText?: string
  width?: number
  height?: number
  headerState?: number
  relationTo?: string
  value?: {
    url?: string
    alt?: string
    width?: number
    height?: number
  }
}

type LexicalContent = {
  root: {
    children: LexicalNode[]
  }
}

// Format flags from Lexical
const IS_BOLD = 1
const IS_ITALIC = 2
const IS_STRIKETHROUGH = 4
const IS_UNDERLINE = 8
const IS_CODE = 16

// --- Table-encoded bullet list detection ---

/** Recursively collect all leaf text nodes from a node tree (handles CMS paragraph wrapping) */
function getTextNodes(node: LexicalNode): LexicalNode[] {
  if (node.type === 'text') return [node]
  const result: LexicalNode[] = []
  for (const child of node.children || []) {
    result.push(...getTextNodes(child))
  }
  return result
}

/** Extract bold header names from a list item (handles merged/trimmed bold nodes) */
function extractTableHeaders(listItem: LexicalNode): string[] {
  const headers: string[] = []
  for (const node of getTextNodes(listItem)) {
    if (((node.format ?? 0) & IS_BOLD) && node.text) {
      const trimmed = node.text.trim()
      if (trimmed.endsWith(':')) {
        headers.push(trimmed.slice(0, -1).trim())
      }
    }
  }
  return headers
}

/** Check if a bullet list matches the table encoding pattern */
function isTablePattern(node: LexicalNode): boolean {
  if (node.listType !== 'bullet') return false
  const items = (node.children || []).filter(c => c.type === 'listitem')
  if (items.length < 2) return false

  const firstHeaders = extractTableHeaders(items[0])
  if (firstHeaders.length < 2) return false

  const headerKey = firstHeaders.join('\0')
  for (let i = 1; i < items.length; i++) {
    if (extractTableHeaders(items[i]).join('\0') !== headerKey) return false
  }
  return true
}

/** Parse headers and row values from a table-encoded bullet list */
function parseTableData(node: LexicalNode): { headers: string[]; rows: string[][] } {
  const items = (node.children || []).filter(c => c.type === 'listitem')
  const headers = extractTableHeaders(items[0])

  const rows: string[][] = []
  for (const item of items) {
    const values: string[] = []
    let currentValue = ''
    let collecting = false

    for (const child of getTextNodes(item)) {
      const isBold = ((child.format ?? 0) & IS_BOLD) !== 0
      const text = child.text || ''

      if (isBold && text.trim().endsWith(':')) {
        // Bold header label — push any collected value and start new cell
        if (collecting) {
          values.push(currentValue.replace(/^[\s|]+/, '').replace(/[\s|]+$/, '').trim())
        }
        currentValue = ''
        collecting = true
      } else if (collecting) {
        currentValue += text
      }
    }
    if (collecting) {
      values.push(currentValue.replace(/^[\s|]+/, '').replace(/[\s|]+$/, '').trim())
    }
    rows.push(values)
  }

  return { headers, rows }
}

function extractText(node: LexicalNode): string {
  if (node.text) return node.text
  if (node.children) return node.children.map(extractText).join('')
  return ''
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

function formatText(text: string, format: number = 0): React.ReactNode {
  let result: React.ReactNode = text

  if (format & IS_CODE) {
    result = <code className="bg-gray-100 px-1 py-0.5 rounded text-sm font-mono">{result}</code>
  }
  if (format & IS_BOLD) {
    result = <strong>{result}</strong>
  }
  if (format & IS_ITALIC) {
    result = <em>{result}</em>
  }
  if (format & IS_UNDERLINE) {
    result = <u>{result}</u>
  }
  if (format & IS_STRIKETHROUGH) {
    result = <s>{result}</s>
  }

  return result
}

function renderNode(node: LexicalNode, index: number): React.ReactNode {
  const key = `node-${index}`

  switch (node.type) {
    case 'text':
      return <React.Fragment key={key}>{formatText(node.text || '', node.format)}</React.Fragment>

    case 'linebreak':
      return <br key={key} />

    case 'paragraph':
      return (
        <p key={key} className="mb-4 leading-relaxed">
          {node.children?.map((child, i) => renderNode(child, i))}
        </p>
      )

    case 'heading': {
      const HeadingTag = (node.tag || 'h2') as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      const headingClasses: Record<string, string> = {
        h1: 'text-3xl font-bold mt-8 mb-4',
        h2: 'text-2xl font-bold mt-6 mb-3',
        h3: 'text-xl font-semibold mt-5 mb-2',
        h4: 'text-lg font-semibold mt-4 mb-2',
        h5: 'text-base font-semibold mt-3 mb-2',
        h6: 'text-sm font-semibold mt-3 mb-2',
      }
      const headingId = slugify(extractText(node))
      return (
        <HeadingTag key={key} id={headingId} className={headingClasses[node.tag || 'h2']}>
          {node.children?.map((child, i) => renderNode(child, i))}
        </HeadingTag>
      )
    }

    case 'list':
      if (node.listType === 'bullet' && isTablePattern(node)) {
        const { headers, rows } = parseTableData(node)
        return <ComparisonTable key={key} headers={headers} rows={rows} />
      }
      if (node.listType === 'number') {
        return (
          <ol key={key} className="list-decimal list-inside mb-4 space-y-1">
            {node.children?.map((child, i) => renderNode(child, i))}
          </ol>
        )
      }
      return (
        <ul key={key} className="list-disc list-inside mb-4 space-y-1">
          {node.children?.map((child, i) => renderNode(child, i))}
        </ul>
      )

    case 'listitem':
      return (
        <li key={key}>
          {node.children?.map((child, i) => renderNode(child, i))}
        </li>
      )

    case 'link':
    case 'autolink': {
      const linkUrl = node.fields?.url || node.url
      const openNewTab = node.fields?.newTab ?? node.newTab
      const fieldRel = node.fields?.rel
      const relParts = new Set<string>()
      if (openNewTab) {
        relParts.add('noopener')
        relParts.add('noreferrer')
      }
      if (fieldRel) {
        fieldRel.split(/\s+/).forEach((r) => relParts.add(r))
      }
      const relStr = relParts.size > 0 ? Array.from(relParts).join(' ') : undefined
      return (
        <a
          key={key}
          href={linkUrl}
          target={openNewTab ? '_blank' : undefined}
          rel={relStr}
          className="text-coral hover:underline"
        >
          {node.children?.map((child, i) => renderNode(child, i))}
        </a>
      )
    }

    case 'quote':
      return (
        <blockquote key={key} className="border-l-4 border-coral pl-4 italic my-4 text-gray-600">
          {node.children?.map((child, i) => renderNode(child, i))}
        </blockquote>
      )

    case 'code':
      return (
        <pre key={key} className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto mb-4">
          <code>
            {node.children?.map((child, i) => renderNode(child, i))}
          </code>
        </pre>
      )

    case 'upload': {
      // Handle media uploads — supports both formats:
      // 1. Blog engine format: node.value is hydrated media doc { url, alt, width, height }
      // 2. Payload v3 native format: media fields at node root level (url, alt, width, height)
      const mediaUrl = node.value?.url || (node as any).url
      const mediaAlt = node.value?.alt || (node as any).alt || (node as any).altText || ''
      const mediaWidth = node.value?.width || (node as any).width
      const mediaHeight = node.value?.height || (node as any).height
      if (mediaUrl) {
        return (
          <figure key={key} className="my-6">
            <img
              src={mediaUrl}
              alt={mediaAlt}
              width={mediaWidth}
              height={mediaHeight}
              className="rounded-lg max-w-full h-auto"
            />
            {mediaAlt && (
              <figcaption className="text-center text-sm text-gray-500 mt-2">
                {mediaAlt}
              </figcaption>
            )}
          </figure>
        )
      }
      return null
    }

    case 'horizontalrule':
      return <hr key={key} className="my-8 border-gray-200" />

    case 'table': {
      // Legacy format: raw HTML string (trusted CMS content, not user-generated)
      if (node.html) {
        return (
          <div
            key={key}
            className="my-6 overflow-x-auto"
            dangerouslySetInnerHTML={{
              __html: node.html.replace(
                '<table',
                '<table class="w-full border-collapse text-sm [&_th]:bg-gray-50 [&_th]:font-semibold [&_th]:text-left [&_th]:px-4 [&_th]:py-2 [&_th]:border [&_th]:border-gray-200 [&_td]:px-4 [&_td]:py-2 [&_td]:border [&_td]:border-gray-200"'
              ),
            }}
          />
        )
      }

      // Native Lexical table — styled with responsive desktop table + mobile cards
      const allRows = (node.children || []).filter(c => c.type === 'tablerow')
      const headerRowIdx = allRows.findIndex(r =>
        r.children?.some(c => c.headerState === 1)
      )
      const headerRow = headerRowIdx >= 0 ? allRows[headerRowIdx] : null
      const dataRows = allRows.filter((_, i) => i !== headerRowIdx)
      const headerCells = headerRow?.children?.filter(c => c.type === 'tablecell') || []
      const headerLabels = headerCells.map(c => extractText(c))

      // Render cell content without the wrapping <p> margins
      const renderCellContent = (cell: LexicalNode): React.ReactNode => {
        const children = cell.children || []
        if (children.length === 1 && children[0].type === 'paragraph') {
          return children[0].children?.map((child, i) => renderNode(child, i))
        }
        return children.map((child, i) => renderNode(child, i))
      }

      const isPriceValue = (text: string) => /\$/.test(text)

      return (
        <div key={key} className="my-6">
          {/* Desktop: horizontal scroll table with sticky first column */}
          <div className="hidden md:block -mx-4 sm:mx-0">
            <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
              <table className="w-full text-sm border-collapse">
                {headerRow && (
                  <thead>
                    <tr>
                      {headerCells.map((cell, ci) => (
                        <th
                          key={ci}
                          className={`bg-navy text-xs font-semibold uppercase tracking-wider text-white px-4 py-3 text-left whitespace-nowrap${
                            ci === 0 ? ' sticky left-0 z-10 bg-navy' : ''
                          }`}
                        >
                          {renderCellContent(cell)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                )}
                <tbody>
                  {dataRows.map((row, ri) => {
                    const cells = (row.children || []).filter(c => c.type === 'tablecell')
                    const stripeBg = ri % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'
                    return (
                      <tr key={ri} className={`group ${stripeBg} hover:bg-coral/5 transition-colors`}>
                        {cells.map((cell, ci) => {
                          const cellText = extractText(cell)
                          const stickyClasses =
                            ci === 0
                              ? `sticky left-0 z-10 font-medium ${stripeBg} group-hover:bg-coral/5 transition-colors`
                              : ''
                          return (
                            <td
                              key={ci}
                              className={`px-4 py-3 border-b border-gray-100 ${stickyClasses}${
                                isPriceValue(cellText) ? ' text-emerald-700 font-mono font-semibold' : ''
                              }`}
                            >
                              {renderCellContent(cell)}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile: card stack */}
          <div className="md:hidden space-y-3">
            {dataRows.map((row, ri) => {
              const cells = (row.children || []).filter(c => c.type === 'tablecell')
              return (
                <div
                  key={ri}
                  className="border border-gray-200 overflow-hidden rounded-xl shadow-sm"
                >
                  <div className="bg-navy text-white font-semibold text-base px-4 py-2.5">
                    {cells[0] ? renderCellContent(cells[0]) : '\u2014'}
                  </div>
                  <div className="px-4 py-3 space-y-2">
                    {cells.slice(1).map((cell, ci) => {
                      const cellText = extractText(cell)
                      return (
                        <div key={ci} className="flex justify-between items-baseline">
                          <span className="text-xs text-gray-500">{headerLabels[ci + 1] || ''}</span>
                          <span
                            className={`text-sm text-right${
                              isPriceValue(cellText) ? ' text-emerald-700 font-mono font-semibold' : ''
                            }`}
                          >
                            {renderCellContent(cell)}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )
    }

    case 'tablerow':
      return (
        <tr key={key}>
          {node.children?.map((child, i) => renderNode(child, i))}
        </tr>
      )

    case 'tablecell': {
      // Standalone tablecell rendering (fallback when table doesn't handle layout directly)
      const isHeader = node.headerState === 1
      const cellClass = isHeader
        ? 'bg-navy text-xs font-semibold uppercase tracking-wider text-white px-4 py-3 text-left whitespace-nowrap'
        : 'px-4 py-3 border-b border-gray-100'
      if (isHeader) {
        return (
          <th key={key} className={cellClass}>
            {node.children?.map((child, i) => renderNode(child, i))}
          </th>
        )
      }
      return (
        <td key={key} className={cellClass}>
          {node.children?.map((child, i) => renderNode(child, i))}
        </td>
      )
    }

    default:
      // For unknown nodes, try to render children
      if (node.children) {
        return (
          <React.Fragment key={key}>
            {node.children.map((child, i) => renderNode(child, i))}
          </React.Fragment>
        )
      }
      return null
  }
}

interface RichTextProps {
  content: LexicalContent | null | undefined
  className?: string
}

export function RichText({ content, className = '' }: RichTextProps) {
  if (!content?.root?.children) {
    return null
  }

  return (
    <div className={`prose prose-slate max-w-none ${className}`}>
      {content.root.children.map((node, index) => renderNode(node, index))}
    </div>
  )
}

export default RichText
