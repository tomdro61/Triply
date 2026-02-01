'use client'

import Image from 'next/image'

export const Logo = () => {
  return (
    <div className="triply-logo">
      <Image
        src="/coral-logo-white.png"
        alt="Triply"
        width={150}
        height={40}
        style={{ objectFit: 'contain' }}
      />
    </div>
  )
}
