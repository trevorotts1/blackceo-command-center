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
        // Light Theme - BlackCEO Command Center
        'bcc-bg': '#F8F9FB',
        'bcc-white': '#FFFFFF',
        'bcc-border': '#E5E7EB',
        'bcc-border-light': '#F3F4F6',
        
        // Text colors
        'bcc-text': '#1A1D26',
        'bcc-text-secondary': '#6B7280',
        'bcc-text-muted': '#9CA3AF',
        
        // Brand colors
        'bcc-primary': '#4F46E5',
        'bcc-primary-hover': '#4338CA',
        'bcc-primary-light': '#EEF2FF',
        
        // Status colors for column pills
        'bcc-inbox': '#3B82F6',
        'bcc-progress': '#10B981',
        'bcc-review': '#F59E0B',
        'bcc-assigned': '#8B5CF6',
        'bcc-done': '#059669',
        'bcc-planning': '#6366F1',
        'bcc-testing': '#06B6D4',
        
        // Priority colors
        'bcc-important': '#DC2626',
        'bcc-high': '#EA580C',
        'bcc-normal': '#2563EB',
        'bcc-low': '#6B7280',
        
        // Legacy dark theme colors (kept for components not yet updated)
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
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      boxShadow: {
        'card': '0 1px 3px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.04)',
        'card-hover': '0 4px 12px rgba(0,0,0,0.1), 0 8px 24px rgba(0,0,0,0.08)',
        'pill': '0 2px 8px rgba(0,0,0,0.15)',
      },
      borderRadius: {
        'xl': '12px',
        '2xl': '16px',
        '3xl': '24px',
      },
    },
  },
  plugins: [],
};

export default config;
