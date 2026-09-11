import type { Config } from 'tailwindcss';

/**
 * Tailwind maps the Atlas tokens in `app/globals.css`; it does not define them
 * (design.md §17, §42).
 *
 * Every colour here is a `var(--atlas-*)` reference. That is what makes the
 * stylesheet the single source of truth — a hex value added to this file would
 * be invisible to anyone reading the tokens, which is exactly how a design
 * system quietly acquires a second palette.
 */
export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './features/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: {
          DEFAULT: 'var(--atlas-bg)',
          subtle: 'var(--atlas-bg-subtle)',
        },
        surface: {
          DEFAULT: 'var(--atlas-surface)',
          raised: 'var(--atlas-surface-raised)',
          elevated: 'var(--atlas-surface-raised)',
          hover: 'var(--atlas-surface-hover)',
          active: 'var(--atlas-surface-active)',
        },
        line: {
          DEFAULT: 'var(--atlas-border)',
          strong: 'var(--atlas-border-strong)',
          emphasis: 'var(--atlas-border-emphasis)',
        },
        ink: {
          DEFAULT: 'var(--atlas-text)',
          secondary: 'var(--atlas-text-secondary)',
          muted: 'var(--atlas-text-muted)',
          disabled: 'var(--atlas-text-disabled)',
        },
        accent: {
          DEFAULT: 'var(--atlas-accent)',
          strong: 'var(--atlas-accent-strong)',
          deep: 'var(--atlas-accent-deep)',
          dim: 'var(--atlas-accent-dim)',
          glow: 'var(--atlas-accent-glow)',
        },
        success: { DEFAULT: 'var(--atlas-success)', dim: 'var(--atlas-success-dim)' },
        warning: { DEFAULT: 'var(--atlas-warning)', dim: 'var(--atlas-warning-dim)' },
        danger: { DEFAULT: 'var(--atlas-danger)', dim: 'var(--atlas-danger-dim)' },
      },

      borderRadius: {
        sm: 'var(--atlas-radius-sm)',
        md: 'var(--atlas-radius-md)',
        lg: 'var(--atlas-radius-lg)',
        xl: 'var(--atlas-radius-xl)',
      },

      boxShadow: {
        sm: 'var(--atlas-shadow-sm)',
        md: 'var(--atlas-shadow-md)',
        lg: 'var(--atlas-shadow-lg)',
      },

      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },

      /**
       * §5: hierarchy comes from weight, spacing and opacity as well as size.
       * Each step pairs a size with the line-height and tracking it needs —
       * large text wants tighter tracking, small text wants looser.
       */
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.02em' }],
        xs: ['0.75rem', { lineHeight: '1.125rem' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
        base: ['0.875rem', { lineHeight: '1.5rem' }],
        lg: ['1rem', { lineHeight: '1.5rem' }],
        xl: ['1.25rem', { lineHeight: '1.75rem', letterSpacing: '-0.01em' }],
        '2xl': ['1.5rem', { lineHeight: '2rem', letterSpacing: '-0.02em' }],
        '3xl': ['1.875rem', { lineHeight: '2.25rem', letterSpacing: '-0.025em' }],
        '4xl': ['2.5rem', { lineHeight: '2.75rem', letterSpacing: '-0.03em' }],
      },

      transitionTimingFunction: {
        atlas: 'var(--atlas-ease)',
      },
      transitionDuration: {
        micro: 'var(--atlas-duration-micro)',
        base: 'var(--atlas-duration-base)',
        slow: 'var(--atlas-duration-slow)',
      },

      spacing: {
        sidebar: 'var(--atlas-sidebar-width)',
      },

      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          from: { transform: 'translateX(-100%)' },
          to: { transform: 'translateX(100%)' },
        },
        // A slow breath, for "this is live and still working".
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.45' },
        },
      },
      animation: {
        'fade-up': 'fade-up var(--atlas-duration-slow) var(--atlas-ease) both',
        shimmer: 'shimmer 1.6s var(--atlas-ease) infinite',
        'pulse-soft': 'pulse-soft 2.4s var(--atlas-ease) infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
