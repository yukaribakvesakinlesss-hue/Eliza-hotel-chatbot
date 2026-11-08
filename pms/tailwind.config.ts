import type { Config } from 'tailwindcss';

/** Same token names as the AXON site (tools/axon-site/tailwind.config.js) so the PMS shares its look. */
const v = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: { 950: v('navy-950'), 900: v('navy-900'), 800: v('navy-800'), 700: v('navy-700'), 600: v('navy-600') },
        gold: { DEFAULT: v('gold'), soft: v('gold-soft'), deep: v('gold-deep'), light: v('gold-light') },
        ink: v('ink'),
        mist: v('mist'),
        silver: v('silver')
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Sora', 'Inter', 'system-ui', 'sans-serif']
      }
    }
  },
  plugins: []
} satisfies Config;
