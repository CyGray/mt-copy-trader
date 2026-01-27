import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        marine: {
          navy: '#0B1F3B',
          navyDark: '#08162B',
          navySoft: '#12315F',
          mist: '#F3F5F9',
        },
      },
    },
  },
  plugins: [],
};

export default config;
