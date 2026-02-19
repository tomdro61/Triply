// Test JSON parsing with code fences like Claude sometimes returns

function parseJsonResponse<T>(text: string): T {
  let jsonStr = text.trim()

  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*)```\s*$/)
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim()
  }

  if (!jsonStr.startsWith('{') && !jsonStr.startsWith('[')) {
    const start = jsonStr.indexOf('{')
    const end = jsonStr.lastIndexOf('}')
    if (start !== -1 && end !== -1 && end > start) {
      jsonStr = jsonStr.slice(start, end + 1)
    }
  }

  return JSON.parse(jsonStr) as T
}

// Test 1: Clean JSON
console.log('Test 1: Clean JSON')
const t1 = parseJsonResponse<{ html: string }>('{"html": "<h2>Test</h2>"}')
console.log('  ✓', t1.html)

// Test 2: Code fenced JSON
console.log('Test 2: Code fenced JSON')
const t2 = parseJsonResponse<{ html: string }>('```json\n{"html": "<h2>Test</h2>"}\n```')
console.log('  ✓', t2.html)

// Test 3: Code fenced without "json" label
console.log('Test 3: Code fenced no label')
const t3 = parseJsonResponse<{ html: string }>('```\n{"html": "<h2>Test</h2>"}\n```')
console.log('  ✓', t3.html)

// Test 4: Code fenced with extra text before
console.log('Test 4: Preamble + code fence')
const t4 = parseJsonResponse<{ html: string }>('Here is the article:\n\n```json\n{"html": "<h2>Test</h2>"}\n```')
console.log('  ✓', t4.html)

// Test 5: Large JSON with nested quotes in HTML
console.log('Test 5: Large JSON with nested HTML')
const t5 = parseJsonResponse<{ html: string; faqItems: { question: string }[] }>(
  '```json\n{"html": "<h2>Parking at JFK</h2><p>The \\"best\\" option is...</p>", "faqItems": [{"question": "How much?"}]}\n```'
)
console.log('  ✓', t5.html.slice(0, 50), '| FAQs:', t5.faqItems.length)

console.log('\nAll parsing tests passed!')
