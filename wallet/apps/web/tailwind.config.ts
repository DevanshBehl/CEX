import type { Config } from 'tailwindcss';

/**
 * Tailwind maps the Atlas tokens in `app/globals.css`; it does not define them
 * (design.md §17, §42).
 *
 * Every colour here is an `--atlas-*` channel reference. That is what makes the
 * stylesheet the single source of truth — a hex value added to this file would
 * be invisible to anyone reading the tokens, which is exactly how a design
 * system quietly acquires a second palette.
 */

/** A channel token, so opacity modifiers (`border-danger/25`) are emitted. */
const c = (token: string) => `rgb(var(${token}) / <alpha-value>)`;

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './features/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: {
          DEFAULT: c('--atlas-bg'),
          subtle: c('--atlas-bg-subtle'),
        },
        surface: {
          DEFAULT: c('--atlas-surface'),
          raised: c('--atlas-surface-raised'),
          elevated: c('--atlas-surface-raised'),
          hover: c('--atlas-surface-hover'),
          active: c('--atlas-surface-active'),
        },
        line: {
          DEFAULT: c('--atlas-border'),
          strong: c('--atlas-border-strong'),
          emphasis: c('--atlas-border-emphasis'),
        },
        ink: {
          DEFAULT: c('--atlas-text'),
          secondary: c('--atlas-text-secondary'),
          muted: c('--atlas-text-muted'),
          disabled: c('--atlas-text-disabled'),
        },
        accent: {
          DEFAULT: c('--atlas-accent'),
          strong: c('--atlas-accent-strong'),
          deep: c('--atlas-accent-deep'),
          dim: c('--atlas-accent-dim'),
          glow: c('--atlas-accent-glow'),
        },
        success: { DEFAULT: c('--atlas-success'), dim: c('--atlas-success-dim') },
        warning: { DEFAULT: c('--atlas-warning'), dim: c('--atlas-warning-dim') },
        danger: { DEFAULT: c('--atlas-danger'), dim: c('--atlas-danger-dim') },
        'on-accent': c('--atlas-on-accent'),
        scrim: c('--atlas-scrim'),
        term: {
          DEFAULT: c('--atlas-term'),
          text: c('--atlas-term-text'),
          ok: c('--atlas-term-ok'),
          note: c('--atlas-term-note'),
        },
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
        topbar: 'var(--atlas-topbar-height)',
      },

      keyframes: {
        fade: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        // A dialog arriving: a short rise with the faintest scale.
        pop: {
          from: { opacity: '0', transform: 'translateY(10px) scale(0.98)' },
          to: { opacity: '1', transform: 'none' },
        },
        // A signal leaving a node: a ring that grows and fades.
        ring: {
          '0%': { transform: 'scale(0.8)', opacity: '0.6' },
          '100%': { transform: 'scale(1.7)', opacity: '0' },
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
        fade: 'fade 300ms var(--atlas-ease) both',
        'fade-up': 'fade-up 400ms var(--atlas-ease) both',
        pop: 'pop 350ms cubic-bezier(0.2, 0.8, 0.3, 1) both',
        ring: 'ring 1.1s ease-out infinite',
        shimmer: 'shimmer 1.6s var(--atlas-ease) infinite',
        'pulse-soft': 'pulse-soft 2.4s var(--atlas-ease) infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
