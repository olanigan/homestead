import plugin from 'tailwindcss/plugin'

/**
 * Theme-aware palette.
 *
 * Every colour is emitted as CSS variables (channels only, so Tailwind's
 * opacity modifiers like bg-emerald-950/20 keep working). The light theme is
 * the default; [data-theme="dark"] restores the original dark palette.
 *
 * The light theme mirrors each scale (50 <-> 950, 100 <-> 900, ...), so
 * classes written for the dark UI (text-gray-100, bg-emerald-950/20,
 * text-amber-400, ...) flip to readable light-theme equivalents without
 * touching the components.
 */

const SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950']
const MIRROR = { 50: 950, 100: 900, 200: 800, 300: 700, 400: 600, 500: 500, 600: 400, 700: 300, 800: 200, 900: 100, 950: 50 }

// Tailwind v3 default palette (dark theme uses these values unchanged).
const DEFAULT_SCALES = {
  gray: ['#f9fafb', '#f3f4f6', '#e5e7eb', '#d1d5db', '#9ca3af', '#6b7280', '#4b5563', '#374151', '#1f2937', '#111827', '#030712'],
  emerald: ['#ecfdf5', '#d1fae5', '#a7f3d0', '#6ee7b7', '#34d399', '#10b981', '#059669', '#047857', '#065f46', '#064e3b', '#022c22'],
  amber: ['#fffbeb', '#fef3c7', '#fde68a', '#fcd34d', '#fbbf24', '#f59e0b', '#d97706', '#b45309', '#92400e', '#78350f', '#451a03'],
  red: ['#fef2f2', '#fee2e2', '#fecaca', '#fca5a5', '#f87171', '#ef4444', '#dc2626', '#b91c1c', '#991b1b', '#7f1d1d', '#450a0a'],
  purple: ['#faf5ff', '#f3e8ff', '#e9d5ff', '#d8b4fe', '#c084fc', '#a855f7', '#9333ea', '#7e22ce', '#6b21a8', '#581c87', '#3b0764'],
  rose: ['#fff1f2', '#ffe4e6', '#fecdd3', '#fda4af', '#fb7185', '#f43f5e', '#e11d48', '#be123c', '#9f1239', '#881337', '#4c0519'],
  // Project brand scale.
  brand: ['#f0f4ff', '#dce6ff', '#b9cdff', '#89acff', '#5580ff', '#2b55ff', '#1133f5', '#0920e1', '#0e1db5', '#111e8e', '#0b1260'],
}

const DARK_SEMANTIC = { surface: '#0d1117', card: '#161b22', border: '#30363d', muted: '#8b949e' }
const LIGHT_SEMANTIC = { surface: '#f6f8fa', card: '#ffffff', border: '#d0d7de', muted: '#57606a' }

const hexToChannels = (hex) => {
  const n = parseInt(hex.slice(1), 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

// Dark: the default scale in order. Light: the mirrored scale.
const scaleVars = (values, mirrored, name) =>
  Object.fromEntries(
    SHADES.map((shade, i) => {
      const hex = mirrored ? values[SHADES.indexOf(String(MIRROR[shade]))] : values[i]
      return [`--c-${name}-${shade}`, hexToChannels(hex)]
    })
  )

const darkVars = {
  ...Object.fromEntries(Object.entries(DEFAULT_SCALES).flatMap(([name, values]) => Object.entries(scaleVars(values, false, name)))),
  ...Object.fromEntries(Object.entries(DARK_SEMANTIC).map(([k, v]) => [`--c-${k}`, hexToChannels(v)])),
}
const lightVars = {
  ...Object.fromEntries(Object.entries(DEFAULT_SCALES).flatMap(([name, values]) => Object.entries(scaleVars(values, true, name)))),
  ...Object.fromEntries(Object.entries(LIGHT_SEMANTIC).map(([k, v]) => [`--c-${k}`, hexToChannels(v)])),
}

const colorRef = (name) => `rgb(var(--c-${name}) / <alpha-value>)`
const scaleRef = (name) => Object.fromEntries(SHADES.map((s) => [s, `rgb(var(--c-${name}-${s}) / <alpha-value>)`]))

const themeVars = plugin(({ addBase }) => {
  addBase({
    ':root, [data-theme="light"]': lightVars,
    '[data-theme="dark"]': darkVars,
  })
})

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        gray: scaleRef('gray'),
        emerald: scaleRef('emerald'),
        amber: scaleRef('amber'),
        red: scaleRef('red'),
        purple: scaleRef('purple'),
        rose: scaleRef('rose'),
        brand: scaleRef('brand'),
        surface: colorRef('surface'),
        card: colorRef('card'),
        border: colorRef('border'),
        muted: colorRef('muted')
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'monospace']
      },
      animation: {
        'ticker-up': 'tickerUp 0.4s ease-out',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'waterfall-in': 'waterfallIn 0.3s ease-out forwards'
      },
      keyframes: {
        tickerUp: {
          '0%':   { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)',   opacity: '1' }
        },
        waterfallIn: {
          '0%':   { opacity: '0', transform: 'translateX(-12px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' }
        }
      }
    }
  },
  plugins: [themeVars]
}
