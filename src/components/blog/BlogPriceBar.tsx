'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { X } from 'lucide-react'
import { money } from '@/lib/fx/usd-label'
import { trackBlogCtaClick } from '@/lib/analytics/gtag'
import { BLOG_BOOKING_PROMPT_ID } from '@/lib/blog/price-bar-arm'

const DISMISS_KEY = 'triply:blog-price-bar-dismissed'

function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

function writeDismissed(): void {
  try {
    window.sessionStorage.setItem(DISMISS_KEY, '1')
  } catch {
    // Storage blocked (private mode): the bar still hides for this page view.
  }
}

/**
 * Sticky "Check prices" bar (price arm only). Hidden while the top booking
 * prompt is on screen, so it never doubles up with it; shown once the reader
 * scrolls past. Closing it hides it for the rest of the browser session.
 *
 * Bottom of the screen on every width. Right padding leaves room for the chat
 * bubble (fixed bottom-4 right-4, z-50); z-40 keeps it under the chat panel
 * and the cookie banner (both z-50).
 */
export function BlogPriceBar({
  airportCode,
  fromPrice,
  fromUsdLabel,
}: {
  airportCode: string
  fromPrice: number
  fromUsdLabel: boolean
}) {
  const [pastPrompt, setPastPrompt] = useState(false)
  const [closedNow, setClosedNow] = useState(false)

  useEffect(() => {
    const prompt = document.getElementById(BLOG_BOOKING_PROMPT_ID)
    // No prompt to anchor on (or a very old browser): never show the bar.
    if (!prompt || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => {
      // Past = out of view AND above the viewport (not still below it on load).
      setPastPrompt(!entry.isIntersecting && entry.boundingClientRect.top < 0)
    })
    observer.observe(prompt)
    return () => observer.disconnect()
  }, [])

  // pastPrompt only turns true in the observer callback, after mount, so
  // sessionStorage is read on the client only and never during hydration.
  if (!pastPrompt || closedNow || readDismissed()) return null

  return (
    <>
    {/* Spacer at the end of the page, as tall as the bar, so the bar never covers the footer's last row. */}
    <div aria-hidden="true" className="h-20" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }} />
    <div
      className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white/95 backdrop-blur shadow-[0_-4px_12px_rgba(0,0,0,0.06)]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="container mx-auto flex items-center gap-3 px-4 py-3 pr-20">
        <p className="min-w-0 flex-1 text-sm text-navy">
          <span className="font-semibold">{airportCode} parking</span>{' '}
          <span className="whitespace-nowrap">
            from <span className="font-bold text-coral">{money(fromPrice, fromUsdLabel)}</span>/day
          </span>
        </p>
        <Link
          href={`/search?airport=${airportCode}`}
          onClick={() => trackBlogCtaClick({ airportCode, placement: 'price-bar' })}
          className="shrink-0 rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-white hover:bg-coral/90 transition-colors"
        >
          Check prices
        </Link>
        <button
          type="button"
          aria-label="Close price bar"
          onClick={() => {
            writeDismissed()
            setClosedNow(true)
          }}
          className="shrink-0 rounded p-2.5 -m-1.5 text-gray-500 hover:text-gray-700"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
    </>
  )
}
