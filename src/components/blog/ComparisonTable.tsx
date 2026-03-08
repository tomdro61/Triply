'use client'

import React from 'react'

interface ComparisonTableProps {
  headers: string[]
  rows: string[][]
}

export function ComparisonTable({ headers, rows }: ComparisonTableProps) {
  const isPrice = (value: string) => /\$/.test(value)

  return (
    <div className="my-6">
      {/* Desktop: horizontal scroll table with sticky first column */}
      <div className="hidden md:block -mx-4 sm:mx-0">
        <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                {headers.map((header, i) => (
                  <th
                    key={i}
                    className={`bg-navy text-xs font-semibold uppercase tracking-wider text-white px-4 py-3 text-left whitespace-nowrap${
                      i === 0 ? ' sticky left-0 z-10 bg-navy' : ''
                    }`}
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => {
                const stripeBg = rowIndex % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'
                return (
                  <tr key={rowIndex} className={`group ${stripeBg} hover:bg-coral/5 transition-colors`}>
                    {headers.map((_, cellIndex) => {
                      const value = row[cellIndex] ?? '—'
                      const stickyClasses =
                        cellIndex === 0
                          ? `sticky left-0 z-10 font-medium ${stripeBg} group-hover:bg-coral/5 transition-colors`
                          : ''
                      return (
                        <td
                          key={cellIndex}
                          className={`px-4 py-3 border-b border-gray-100 ${stickyClasses}${
                            isPrice(value) ? ' text-emerald-700 font-mono font-semibold' : ''
                          }`}
                        >
                          {value}
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
        {rows.map((row, rowIndex) => (
          <div
            key={rowIndex}
            className="border border-gray-200 overflow-hidden rounded-xl shadow-sm"
          >
            <div className="bg-navy text-white font-semibold text-base px-4 py-2.5">
              {row[0] || '—'}
            </div>
            <div className="px-4 py-3 space-y-2">
              {headers.slice(1).map((header, i) => {
                const value = row[i + 1] || '—'
                return (
                  <div key={i} className="flex justify-between items-baseline">
                    <span className="text-xs text-gray-500">{header}</span>
                    <span
                      className={`text-sm text-right${
                        isPrice(value) ? ' text-emerald-700 font-mono font-semibold' : ''
                      }`}
                    >
                      {value}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
