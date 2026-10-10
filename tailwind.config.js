/** @type {import('tailwindcss').Config} */
// Colors come from CSS variables in src/index.css so light/dark mode
// swap automatically. `<alpha-value>` lets classes like bg-pos/10 work.
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'),
        surface: v('surface'),
        subtle: v('subtle'),
        line: v('line'),
        'line-strong': v('line-strong'),
        ink: v('ink'),
        'ink-2': v('ink-2'),
        muted: v('muted'),
        faint: v('faint'),
        accent: v('accent'),
        pos: v('pos'),
        neg: v('neg'),
        warn: v('warn'),
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(0 0 0 / 0.04)',
      },
    },
  },
  plugins: [],
};
