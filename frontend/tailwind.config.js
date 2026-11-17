/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        obsidian: {
          950: '#060911',
          900: '#090D16',
          850: '#0D1321',
          800: '#111827',
          750: '#172033',
          700: '#1E293B',
        },
      },
      fontFamily: {
        sans: ['"Space Grotesk"', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'],
      },
      boxShadow: {
        'glow-emerald': '0 0 24px -6px rgba(16, 185, 129, 0.35)',
        'glow-cyan': '0 0 24px -6px rgba(6, 182, 212, 0.35)',
        'glow-amber': '0 0 24px -6px rgba(245, 158, 11, 0.3)',
        'glow-rose': '0 0 24px -6px rgba(244, 63, 94, 0.35)',
      },
    },
  },
  plugins: [],
};
