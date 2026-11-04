import type { Preview } from '@storybook/nextjs-vite'
import '@fontsource-variable/inter/wght.css'
import '@fontsource-variable/manrope/wght.css'
import '../src/app/globals.css'
import './storybook.css'

const preview: Preview = {
  parameters: {
    layout: 'padded',
  },
}

export default preview
