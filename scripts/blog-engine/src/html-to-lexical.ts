import { parse, HTMLElement, TextNode, Node, NodeType } from 'node-html-parser'

// Lexical node types
interface LexicalTextNode {
  type: 'text'
  text: string
  format: number
  detail: number
  mode: 'normal'
  style: string
  version: 1
}

interface LexicalLinebreakNode {
  type: 'linebreak'
  version: 1
}

interface LexicalElementNode {
  type: string
  children: LexicalNode[]
  direction: 'ltr'
  format: string
  indent: number
  version: 1
}

interface LexicalParagraphNode extends LexicalElementNode {
  type: 'paragraph'
  textFormat: number
  textStyle: string
}

interface LexicalHeadingNode extends LexicalElementNode {
  type: 'heading'
  tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  textFormat: number
  textStyle: string
}

interface LexicalListNode extends LexicalElementNode {
  type: 'list'
  listType: 'bullet' | 'number'
  start: number
  tag: 'ul' | 'ol'
}

interface LexicalListItemNode extends LexicalElementNode {
  type: 'listitem'
  checked: boolean
  value: number
}

interface LexicalLinkNode extends LexicalElementNode {
  type: 'link'
  fields: {
    linkType: 'custom'
    url: string
    newTab: boolean
    rel?: string
  }
}

interface LexicalQuoteNode extends LexicalElementNode {
  type: 'quote'
  textFormat: number
  textStyle: string
}

export interface LexicalUploadNode {
  type: 'upload'
  relationTo: 'media'
  value: number | string  // Media ID — Payload hydrates to full media doc on fetch (depth > 0)
  version: 2
}

interface LexicalTableNode extends LexicalElementNode {
  type: 'table'
}

interface LexicalTableRowNode extends LexicalElementNode {
  type: 'tablerow'
}

interface LexicalTableCellNode extends LexicalElementNode {
  type: 'tablecell'
  headerState: 0 | 1
}

interface LexicalRootNode {
  type: 'root'
  children: LexicalNode[]
  direction: 'ltr'
  format: string
  indent: number
  version: 1
}

type LexicalNode =
  | LexicalTextNode
  | LexicalLinebreakNode
  | LexicalParagraphNode
  | LexicalHeadingNode
  | LexicalListNode
  | LexicalListItemNode
  | LexicalLinkNode
  | LexicalQuoteNode
  | LexicalUploadNode
  | LexicalTableNode
  | LexicalTableRowNode
  | LexicalTableCellNode
  | LexicalElementNode

export interface LexicalDocument {
  root: LexicalRootNode
}

// Format bitmask values
const FORMAT_BOLD = 1
const FORMAT_ITALIC = 2

function makeTextNode(text: string, format = 0): LexicalTextNode {
  return {
    type: 'text',
    text,
    format,
    detail: 0,
    mode: 'normal',
    style: '',
    version: 1,
  }
}

function makeLinebreakNode(): LexicalLinebreakNode {
  return { type: 'linebreak', version: 1 }
}

function makeParagraphNode(children: LexicalNode[]): LexicalParagraphNode {
  return {
    type: 'paragraph',
    children,
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
    textFormat: 0,
    textStyle: '',
  }
}

function makeHeadingNode(
  tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6',
  children: LexicalNode[]
): LexicalHeadingNode {
  return {
    type: 'heading',
    tag,
    children,
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
    textFormat: 0,
    textStyle: '',
  }
}

function makeListNode(
  listType: 'bullet' | 'number',
  tag: 'ul' | 'ol',
  children: LexicalNode[]
): LexicalListNode {
  return {
    type: 'list',
    listType,
    tag,
    start: 1,
    children,
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
  }
}

function makeListItemNode(children: LexicalNode[], value = 1): LexicalListItemNode {
  return {
    type: 'listitem',
    checked: false,
    value,
    children,
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
  }
}

function makeLinkNode(url: string, children: LexicalNode[], rel?: string): LexicalLinkNode {
  return {
    type: 'link',
    fields: {
      linkType: 'custom',
      url,
      newTab: false,
      ...(rel ? { rel } : {}),
    },
    children,
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
  }
}

function makeQuoteNode(children: LexicalNode[]): LexicalQuoteNode {
  return {
    type: 'quote',
    children,
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
    textFormat: 0,
    textStyle: '',
  }
}

function makeTableNode(children: LexicalNode[]): LexicalTableNode {
  return {
    type: 'table',
    children,
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
  }
}

function makeTableRowNode(children: LexicalNode[]): LexicalTableRowNode {
  return {
    type: 'tablerow',
    children,
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
  }
}

function makeTableCellNode(children: LexicalNode[], headerState: 0 | 1 = 0): LexicalTableCellNode {
  return {
    type: 'tablecell',
    headerState,
    children,
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
  }
}

function makeUploadNode(id: string, _url: string, _alt: string, _width: number, _height: number): LexicalUploadNode {
  // Payload expects the media ID as a number (Postgres integer PK)
  const numericId = parseInt(id, 10)
  return {
    type: 'upload',
    relationTo: 'media',
    value: isNaN(numericId) ? id : numericId,
    version: 2,
  }
}

/**
 * Convert inline HTML children to Lexical inline nodes (text, bold, italic, links, linebreaks).
 * `inheritFormat` carries the bitmask from parent formatting tags.
 */
function convertInlineChildren(node: HTMLElement | Node, inheritFormat = 0): LexicalNode[] {
  const result: LexicalNode[] = []

  if (!('childNodes' in node)) return result

  for (const child of (node as HTMLElement).childNodes) {
    if (child.nodeType === NodeType.TEXT_NODE) {
      const text = (child as TextNode).rawText
      if (text) {
        result.push(makeTextNode(text, inheritFormat))
      }
      continue
    }

    if (child.nodeType !== NodeType.ELEMENT_NODE) continue

    const el = child as HTMLElement
    const tag = el.tagName?.toLowerCase()

    switch (tag) {
      case 'strong':
      case 'b':
        result.push(...convertInlineChildren(el, inheritFormat | FORMAT_BOLD))
        break
      case 'em':
      case 'i':
        result.push(...convertInlineChildren(el, inheritFormat | FORMAT_ITALIC))
        break
      case 'a': {
        const href = el.getAttribute('href') || ''
        const rel = el.getAttribute('rel') || undefined
        const linkChildren = convertInlineChildren(el, inheritFormat)
        if (linkChildren.length > 0) {
          result.push(makeLinkNode(href, linkChildren, rel))
        }
        break
      }
      case 'br':
        result.push(makeLinebreakNode())
        break
      default:
        // Unsupported inline tag — extract text content preserving formatting
        result.push(...convertInlineChildren(el, inheritFormat))
        break
    }
  }

  return result
}

/**
 * Convert a block-level HTML element to Lexical block nodes.
 */
function convertBlockElement(el: HTMLElement): LexicalNode[] {
  const tag = el.tagName?.toLowerCase()

  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const children = convertInlineChildren(el)
      if (children.length === 0) children.push(makeTextNode(''))
      return [makeHeadingNode(tag as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6', children)]
    }

    case 'p': {
      const children = convertInlineChildren(el)
      if (children.length === 0) children.push(makeTextNode(''))
      return [makeParagraphNode(children)]
    }

    case 'ul':
    case 'ol': {
      const listType = tag === 'ol' ? 'number' : 'bullet'
      const listTag = tag as 'ul' | 'ol'
      const items: LexicalNode[] = []
      let itemIndex = 1

      for (const child of el.childNodes) {
        if (child.nodeType !== NodeType.ELEMENT_NODE) continue
        const childEl = child as HTMLElement
        if (childEl.tagName?.toLowerCase() === 'li') {
          // Check if li contains nested list(s)
          const nestedLists: LexicalNode[] = []
          const inlineContent: LexicalNode[] = []

          for (const liChild of childEl.childNodes) {
            if (liChild.nodeType === NodeType.ELEMENT_NODE) {
              const liChildEl = liChild as HTMLElement
              const liChildTag = liChildEl.tagName?.toLowerCase()
              if (liChildTag === 'ul' || liChildTag === 'ol') {
                nestedLists.push(...convertBlockElement(liChildEl))
              } else {
                inlineContent.push(...convertInlineChildren(liChildEl))
              }
            } else if (liChild.nodeType === NodeType.TEXT_NODE) {
              const text = (liChild as TextNode).rawText
              if (text) inlineContent.push(makeTextNode(text))
            }
          }

          if (inlineContent.length === 0) inlineContent.push(makeTextNode(''))
          items.push(makeListItemNode(inlineContent, itemIndex))

          // Wrap nested lists in listitem nodes so Lexical structure stays valid
          for (const nestedList of nestedLists) {
            items.push(makeListItemNode([makeTextNode('')], itemIndex))
            // Attach nested list as a child of the preceding listitem
            const wrapperItem = items[items.length - 1]
            ;(wrapperItem as { children: LexicalNode[] }).children = [nestedList]
          }

          itemIndex++
        }
      }

      if (items.length === 0) {
        items.push(makeListItemNode([makeTextNode('')], 1))
      }

      return [makeListNode(listType, listTag, items)]
    }

    case 'blockquote': {
      const children = convertInlineChildren(el)
      if (children.length === 0) children.push(makeTextNode(''))
      return [makeQuoteNode(children)]
    }

    case 'table': {
      // Convert HTML tables to native Lexical table nodes.
      // Requires TableFeature() in the CMS Lexical editor config,
      // and the frontend RichText.tsx must handle table/tablerow/tablecell nodes.

      const rowEls: HTMLElement[] = []
      const headerEls: HTMLElement[] = []
      for (const child of el.childNodes) {
        if (child.nodeType !== NodeType.ELEMENT_NODE) continue
        const childEl = child as HTMLElement
        const childTag = childEl.tagName?.toLowerCase()
        if (childTag === 'tr') {
          rowEls.push(childEl)
        } else if (childTag === 'thead') {
          for (const grandchild of childEl.childNodes) {
            if (grandchild.nodeType === NodeType.ELEMENT_NODE && (grandchild as HTMLElement).tagName?.toLowerCase() === 'tr') {
              headerEls.push(grandchild as HTMLElement)
            }
          }
        } else if (childTag === 'tbody' || childTag === 'tfoot') {
          for (const grandchild of childEl.childNodes) {
            if (grandchild.nodeType === NodeType.ELEMENT_NODE && (grandchild as HTMLElement).tagName?.toLowerCase() === 'tr') {
              rowEls.push(grandchild as HTMLElement)
            }
          }
        }
      }

      const allRows: HTMLElement[] = [...headerEls, ...rowEls]
      if (allRows.length === 0) return []

      const tableRows: LexicalNode[] = []
      for (const rowEl of allRows) {
        const cells: LexicalNode[] = []
        for (const cellChild of rowEl.childNodes) {
          if (cellChild.nodeType !== NodeType.ELEMENT_NODE) continue
          const cellEl = cellChild as HTMLElement
          const cellTag = cellEl.tagName?.toLowerCase()
          if (cellTag === 'th' || cellTag === 'td') {
            const isHeader = cellTag === 'th' ? 1 : 0
            const cellContent = convertInlineChildren(cellEl)
            if (cellContent.length === 0) cellContent.push(makeTextNode(''))
            cells.push(makeTableCellNode([makeParagraphNode(cellContent)], isHeader as 0 | 1))
          }
        }
        if (cells.length > 0) {
          tableRows.push(makeTableRowNode(cells))
        }
      }

      if (tableRows.length === 0) return []
      return [makeTableNode(tableRows)]
    }

    case 'figure': {
      // Handle <figure> wrapping <img> with optional <figcaption>
      const imgEl = el.querySelector('img')
      if (imgEl) {
        const id = imgEl.getAttribute('data-media-id') || ''
        const src = imgEl.getAttribute('src') || ''
        const alt = imgEl.getAttribute('alt') || ''
        const width = parseInt(imgEl.getAttribute('data-width') || imgEl.getAttribute('width') || '0', 10)
        const height = parseInt(imgEl.getAttribute('data-height') || imgEl.getAttribute('height') || '0', 10)
        // Use figcaption as alt text if present and no alt on img
        if (!alt) {
          const figcaption = el.querySelector('figcaption')
          if (figcaption) {
            return [makeUploadNode(id, src, figcaption.textContent.trim(), width, height)]
          }
        }
        return [makeUploadNode(id, src, alt, width, height)]
      }
      // Not an image figure — convert children normally
      return convertChildBlocks(el)
    }

    case 'img': {
      // Convert <img> to Lexical upload node
      // data-media-id and data-width/data-height are set by the inline-images resolver
      const id = el.getAttribute('data-media-id') || ''
      const src = el.getAttribute('src') || ''
      const alt = el.getAttribute('alt') || ''
      const width = parseInt(el.getAttribute('data-width') || el.getAttribute('width') || '0', 10)
      const height = parseInt(el.getAttribute('data-height') || el.getAttribute('height') || '0', 10)
      return [makeUploadNode(id, src, alt, width, height)]
    }

    case 'br':
      return [] // Block-level br is ignored (only inline br matters)

    default:
      // Unsupported block element — try to convert children as blocks
      // If it has block children, recurse; otherwise wrap text in a paragraph
      return convertChildBlocks(el)
  }
}

/**
 * Convert all child elements of a container to block-level Lexical nodes.
 * Text nodes at the block level get wrapped in paragraphs.
 */
function convertChildBlocks(container: HTMLElement): LexicalNode[] {
  const result: LexicalNode[] = []
  let pendingInline: LexicalNode[] = []

  function flushInline() {
    if (pendingInline.length > 0) {
      result.push(makeParagraphNode(pendingInline))
      pendingInline = []
    }
  }

  for (const child of container.childNodes) {
    if (child.nodeType === NodeType.TEXT_NODE) {
      const text = (child as TextNode).rawText.trim()
      if (text) {
        pendingInline.push(makeTextNode(text))
      }
      continue
    }

    if (child.nodeType !== NodeType.ELEMENT_NODE) continue

    const el = child as HTMLElement
    const tag = el.tagName?.toLowerCase()

    // Block-level elements flush pending inline and convert as blocks
    const blockTags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'blockquote', 'div', 'section', 'article', 'main', 'header', 'footer', 'table', 'figure', 'img', 'pre']

    if (blockTags.includes(tag)) {
      flushInline()
      result.push(...convertBlockElement(el))
    } else {
      // Inline element at block level — accumulate
      pendingInline.push(...convertInlineChildren(el))
    }
  }

  flushInline()
  return result
}

/**
 * Convert an HTML string to a Payload Lexical JSON document.
 */
export function htmlToLexical(html: string): LexicalDocument {
  const root = parse(html, {
    lowerCaseTagName: true,
    comment: false,
  })

  const children = convertChildBlocks(root)

  // Ensure at least one child (empty paragraph)
  if (children.length === 0) {
    children.push(makeParagraphNode([makeTextNode('')]))
  }

  return {
    root: {
      type: 'root',
      children,
      direction: 'ltr',
      format: '',
      indent: 0,
      version: 1,
    },
  }
}

/**
 * Extract plain text from Lexical nodes (for generating heading IDs, etc.)
 */
export function extractTextFromLexical(nodes: LexicalNode[]): string {
  let text = ''
  for (const node of nodes) {
    if ('text' in node && node.type === 'text') {
      text += node.text
    }
    if ('children' in node && node.children) {
      text += extractTextFromLexical(node.children as LexicalNode[])
    }
  }
  return text
}

