const token =
  (name) =>
  ({ opacityValue, opacityVariable }) =>
    opacityVariable || opacityValue === undefined
      ? `var(--${name})`
      : `color-mix(in srgb, var(--${name}) calc(${opacityValue} * 100%), transparent)`;

const colors = (names) =>
  Object.fromEntries(Object.entries(names).map(([key, name]) => [key, token(name)]));

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ...colors({
          canvas: 'canvas',
          surface: 'surface',
          raised: 'surface-raised',
          ink: 'ink',
          line: 'line',
          control: 'control',
          focus: 'focus',
          action: 'action',
          'action-hover': 'action-hover',
          'action-line': 'action-line',
          'on-action': 'on-action',
          accent: 'accent',
          'on-accent': 'on-accent',
          inverse: 'inverse',
          'inverse-raised': 'inverse-raised',
          'inverse-ink': 'inverse-ink',
          'inverse-muted': 'inverse-muted',
          scrim: 'scrim',
          paper: 'paper',
        }),
        stone: colors({
          50: 'surface-muted',
          100: 'surface-hover',
          200: 'line',
          300: 'line-strong',
          400: 'muted',
          500: 'muted',
          600: 'muted',
          700: 'text-secondary',
          800: 'text-secondary',
          900: 'ink',
          950: 'ink',
        }),
        lime: colors({
          50: 'accent-soft',
          100: 'accent-soft',
          200: 'accent-line',
          300: 'accent-active',
          400: 'accent-line',
          500: 'accent',
          600: 'accent-hover',
          700: 'accent-ink',
          800: 'accent-ink',
          900: 'accent-ink',
          950: 'accent-ink',
        }),
        green: colors({
          50: 'success-soft',
          100: 'success-soft',
          200: 'success-line',
          500: 'success-ink',
          700: 'success-ink',
          800: 'success-ink',
          900: 'success-ink',
        }),
        amber: colors({
          50: 'warning-soft',
          100: 'warning-soft',
          200: 'warning-line',
          700: 'warning-ink',
          800: 'warning-ink',
          900: 'warning-ink',
          950: 'warning-ink',
        }),
        rose: colors({
          50: 'danger-soft',
          100: 'danger-soft',
          200: 'danger-line',
          300: 'danger-line',
          500: 'danger-ink',
          600: 'danger-ink',
          700: 'danger-ink',
          800: 'danger-ink',
          900: 'danger-ink',
        }),
        red: colors({
          50: 'danger-soft',
          700: 'danger-action',
          800: 'danger-ink',
          900: 'danger-ink',
        }),
        ...colors({ 'danger-hover': 'danger-hover', 'on-danger': 'on-danger' }),
        blue: colors({ 50: 'info-soft', 900: 'info-ink' }),
      },
      borderColor: { DEFAULT: 'var(--line)' },
      boxShadow: {
        sm: '0 1px 2px var(--shadow-soft)',
        DEFAULT: '0 1px 3px var(--shadow-soft), 0 1px 2px var(--shadow-soft)',
        md: '0 4px 8px var(--shadow-soft)',
        lg: '0 8px 18px var(--shadow-soft)',
        xl: '0 14px 26px var(--shadow)',
        '2xl': '0 22px 48px var(--shadow)',
        inner: 'inset 0 2px 4px var(--shadow-soft)',
      },
      fontFamily: { sans: ['Fabric Grotesk', 'Arial', 'sans-serif'] },
      borderRadius: { xl: '1rem', '2xl': '1.5rem' },
    },
  },
  plugins: [],
};
