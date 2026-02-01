'use client'

import Image from 'next/image'

export const Icon = () => {
  return (
    <div className="triply-icon">
      <Image
        src="/coral-logo-white.png"
        alt="Triply"
        width={32}
        height={32}
        style={{ objectFit: 'contain' }}
      />
    </div>
  )
}
