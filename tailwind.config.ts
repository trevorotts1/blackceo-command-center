import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // BlackCEO Command Center brand colors
        'mc-bg': '#000000',
        'mc-bg-secondary': '#1A1A1A',
        'mc-bg-tertiary': '#262626',
        'mc-border': '#333333',
        'mc-text': '#FFFFFF',
        'mc-text-secondary': '#999999',
        'mc-accent': '#FF0000',
        'mc-accent-green': '#00FF00',
        'mc-accent-yellow': '#FFA500',
        'mc-accent-red': '#FF0000',
        'mc-accent-purple': '#a371f7',
        'mc-accent-pink': '#FF0000',
        'mc-accent-cyan': '#FF0000',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
