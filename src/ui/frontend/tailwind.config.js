/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#f0f4ff',
          100: '#dce6ff',
          200: '#b9cdff',
          300: '#89acff',
          400: '#5580ff',
          500: '#2b55ff',
          600: '#1133f5',
          700: '#0920e1',
          800: '#0e1db5',
          900: '#111e8e',
          950: '#0b1260'
        },
        surface: '#0d1117',
        card:    '#161b22',
        border:  '#30363d',
        muted:   '#8b949e'
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
  plugins: []
};
