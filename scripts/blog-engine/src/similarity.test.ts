import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rankBySimilarity, similarity } from './similarity.js'

test('similarity is Jaccard over tokens', () => {
  assert.equal(similarity(['cost', 'long-term'], ['cost', 'long-term']), 1)
  assert.equal(similarity(['cost'], ['shuttle']), 0)
  assert.equal(similarity([], ['x']), 0)
})

test('rankBySimilarity puts the hub first, then the closest intent', () => {
  const posts = [
    { slug: 'bwi-cell-phone-lot', articleType: 'spoke' },
    { slug: 'bwi-long-term-parking-rates', articleType: 'spoke' },
    { slug: 'bwi-airport-parking', articleType: 'hub' },
    { slug: 'bwi-parking-shuttle', articleType: 'spoke' },
  ]
  const ranked = rankBySimilarity('bwi long term parking cost', 'BWI', posts).map((p) => p.slug)
  assert.equal(ranked[0], 'bwi-airport-parking')
  assert.equal(ranked[1], 'bwi-long-term-parking-rates')
})
