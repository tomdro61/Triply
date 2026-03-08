'use client'

import React, { useState } from 'react'

type LexicalNode = {
  type: string
  children?: LexicalNode[]
  text?: string
  tag?: string
  format?: number
}

type LexicalContent = {
  root: {
    children: LexicalNode[]
  }
}

interface TocItem {
  id: string
  text: string
  level: 2 | 3
}

function extractText(node: LexicalNode): string {
  if (node.text) return node.text
  if (node.children) return node.children.map(extractText).join('')
  return ''
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

export function extractTocItems(content: LexicalContent | null | undefined): TocItem[] {
  if (!content?.root?.children) return []

  const items: TocItem[] = []
  for (const node of content.root.children) {
    if (node.type === 'heading' && (node.tag === 'h2' || node.tag === 'h3')) {
      const text = extractText(node)
      if (text.trim()) {
        items.push({
          id: slugify(text),
          text: text.trim(),
          level: node.tag === 'h2' ? 2 : 3,
        })
      }
    }
  }

  return items
}

interface TableOfContentsProps {
  content: LexicalContent | null | undefined
  minHeadings?: number
}

export function TableOfContents({ content, minHeadings = 3 }: TableOfContentsProps) {
  const [isExpanded, setIsExpanded] = useState(true)
  const items = extractTocItems(content)

  if (items.length < minHeadings) return null

  return (
    <nav aria-label="Table of contents" className="bg-gray-50 rounded-lg p-5 mb-8 border border-gray-200">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center justify-between w-full text-left"
        aria-expanded={isExpanded}
      >
        <h2 className="text-sm font-semibold text-navy uppercase tracking-wide m-0">
          In This Article
        </h2>
        <svg
          className={`w-4 h-4 text-gray-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isExpanded && (
        <ol className="mt-3 space-y-1 list-none p-0 m-0">
          {items.map((item, index) => (
            <li key={item.id} className={item.level === 3 ? 'ml-4' : ''}>
              <a
                href={`#${item.id}`}
                className="text-sm text-gray-600 hover:text-coral transition-colors block py-0.5 no-underline"
              >
                {item.level === 2 && (
                  <span className="text-gray-400 mr-1.5 font-mono text-xs">
                    {items.filter((i, j) => j <= index && i.level === 2).length}.
                  </span>
                )}
                {item.text}
              </a>
            </li>
          ))}
        </ol>
      )}
    </nav>
  )
}

export default TableOfContents
