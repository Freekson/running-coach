import { Inter, Manrope } from 'next/font/google'

export const headingFont = Manrope({
  subsets: ['latin', 'cyrillic'],
  display: 'swap',
  adjustFontFallback: true,
  variable: '--font-heading',
})

export const bodyFont = Inter({
  subsets: ['latin', 'cyrillic'],
  display: 'swap',
  adjustFontFallback: true,
  variable: '--font-body',
})
