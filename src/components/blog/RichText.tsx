'use client'

import React from 'react'

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
  }
  newTab?: boolean
  src?: string
  altText?: string
  width?: number
  height?: number
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
      return (
        <a
          key={key}
          href={linkUrl}
          target={openNewTab ? '_blank' : undefined}
          rel={openNewTab ? 'noopener noreferrer' : undefined}
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

    case 'upload':
      // Handle media uploads
      const media = node.value
      if (media?.url) {
        return (
          <figure key={key} className="my-6">
            <img
              src={media.url}
              alt={media.alt || ''}
              width={media.width}
              height={media.height}
              className="rounded-lg max-w-full h-auto"
            />
            {media.alt && (
              <figcaption className="text-center text-sm text-gray-500 mt-2">
                {media.alt}
              </figcaption>
            )}
          </figure>
        )
      }
      return null

    case 'horizontalrule':
      return <hr key={key} className="my-8 border-gray-200" />

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
