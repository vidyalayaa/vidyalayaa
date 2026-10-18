export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: { lime: { 500: '#c7f55b', 600: '#9fce3d' }, ink: '#171b16', canvas: '#f6f7f3' },
      fontFamily: { sans: ['Fabric Grotesk', 'Arial', 'sans-serif'] },
      borderRadius: { xl: '1rem', '2xl': '1.5rem' },
    },
  },
  plugins: [],
};
