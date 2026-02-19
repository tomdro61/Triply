/**
 * Convert Payload Lexical JSON back to HTML for SEO scoring.
 * This is the reverse of html-to-lexical.ts.
 */

interface LexicalNode {
  type: string
  text?: string
  format?: number | string
  tag?: string
  listType?: string
  children?: LexicalNode[]
  fields?: {
    linkType?: string
    url?: string
    newTab?: boolean
  }
}

interface LexicalDocument {
  root: {
    children: LexicalNode[]
  }
}

const FORMAT_BOLD = 1
const FORMAT_ITALIC = 2

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderInlineNode(node: LexicalNode): string {
  if (node.type === 'text') {
    let html = escapeHtml(node.text || '')
    const format = typeof node.format === 'number' ? node.format : 0
    if (format & FORMAT_BOLD) html = `<strong>${html}</strong>`
    if (format & FORMAT_ITALIC) html = `<em>${html}</em>`
    return html
  }

  if (node.type === 'linebreak') {
    return '<br>'
  }

  if (node.type === 'link') {
    const url = node.fields?.url || ''
    const inner = (node.children || []).map(renderInlineNode).join('')
    return `<a href="${escapeHtml(url)}">${inner}</a>`
  }

  // Fallback: render children
  if (node.children) {
    return node.children.map(renderInlineNode).join('')
  }

  return ''
}

function renderBlockNode(node: LexicalNode): string {
  const children = node.children || []

  switch (node.type) {
    case 'heading': {
      const tag = node.tag || 'h2'
      const inner = children.map(renderInlineNode).join('')
      return `<${tag}>${inner}</${tag}>`
    }

    case 'paragraph': {
      const inner = children.map(renderInlineNode).join('')
      return `<p>${inner}</p>`
    }

    case 'list': {
      const tag = node.listType === 'number' ? 'ol' : 'ul'
      const items = children.map(renderBlockNode).join('')
      return `<${tag}>${items}</${tag}>`
    }

    case 'listitem': {
      const inner = children.map(renderInlineNode).join('')
      return `<li>${inner}</li>`
    }

    case 'quote': {
      const inner = children.map(renderInlineNode).join('')
      return `<blockquote>${inner}</blockquote>`
    }

    default: {
      // Unknown block type — render children
      return children.map(renderBlockNode).join('')
    }
  }
}

export function lexicalToHtml(doc: LexicalDocument): string {
  if (!doc?.root?.children) return ''
  return doc.root.children.map(renderBlockNode).join('\n')
}
