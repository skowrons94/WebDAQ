'use client'

import { useEffect, useState } from 'react'

/** True below 768 px (Tailwind's md); false on the server and first render. */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const update = () => setPhone(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return phone
}
