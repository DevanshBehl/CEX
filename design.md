# ATLAS — GLOBAL UI THEME & DESIGN SYSTEM PROMPT

## Objective

Upgrade the existing Atlas frontend into a premium, highly polished financial technology interface.

This is a **global visual-system upgrade**, not a page redesign.

Do NOT assume or require specific pages, routes, products, workflows, or dashboard structures.

The existing application functionality must remain intact.

The task is to establish a reusable visual language that can scale from the current wallet product to the future Atlas ecosystem.

Atlas should feel like a serious financial infrastructure company, not a generic crypto startup.

Target perception:

> Institutional. Precise. Technical. Premium. Reliable. Fast. Engineered.

The visual quality should be comparable to the best modern developer and financial-product websites, with inspiration from:

* Tailwind CSS
* Linear
* Vercel
* Stripe
* Bloomberg-style financial interfaces
* Premium institutional trading platforms

Do NOT copy any company's branding, exact layouts, illustrations, or identity.

---

# 1. Global Visual Identity

Atlas should have a recognizable visual language based on:

* Precision
* Grid systems
* Technical typography
* Restrained color
* Fine borders
* Strong alignment
* Excellent whitespace
* Subtle gradients
* Data-oriented visual hierarchy
* Deliberate motion

The interface should look **expensive because of composition and detail**, not because of excessive decoration.

Avoid the typical AI-generated SaaS aesthetic.

Do NOT use:

* Excessive rounded cards
* Huge gradients
* Purple/blue gradient overload
* Neon crypto aesthetics
* Giant glowing blobs
* Heavy shadows
* Excessive glassmorphism
* Cartoon illustrations
* Emoji-heavy interfaces
* Random decorative shapes
* Generic "three cards + giant hero" patterns
* Excessive pill-shaped UI
* Fake complexity

---

# 2. Design Principle

Use the principle:

> Less decoration. More system.

The interface should feel deliberately engineered.

Every element should communicate:

* hierarchy
* state
* information
* interaction
* structure

Avoid decorative elements that don't improve usability or brand identity.

---

# 3. Primary Theme

Atlas should be **dark-mode-first**.

Base background:

```text
#09090B
```

Secondary surfaces:

```text
#0D0D10
#111114
```

Borders:

```text
rgba(255,255,255,0.06)
rgba(255,255,255,0.08)
rgba(255,255,255,0.14)
```

The interface should have very subtle variations between surfaces rather than relying heavily on shadows.

Do not use pure black as the default background.

---

# 4. Typography

Typography should be one of the strongest parts of the design.

Preferred fonts:

```text
Inter
Geist
IBM Plex Sans
```

For financial/numeric/technical information:

```text
Geist Mono
IBM Plex Mono
system monospace
```

Use tabular numerals wherever numerical alignment matters.

Examples:

* financial values
* percentages
* timestamps
* transaction IDs
* prices
* balances
* quantities

Typography should generally be:

* clean
* compact
* sharp
* highly legible

Avoid excessively rounded or playful typefaces.

---

# 5. Typography Hierarchy

Establish a clear hierarchy.

Large titles:

* strong weight
* tight line-height
* slightly tighter tracking

Section titles:

* confident
* restrained

Body:

* highly readable
* moderate line-height

Metadata:

* smaller
* muted
* compact

System labels:

* small
* precise
* sometimes monospace

Do not create hierarchy using font size alone.

Also use:

* weight
* spacing
* opacity
* alignment
* borders
* whitespace

---

# 6. Atlas Accent

Atlas should use a restrained technical accent.

Preferred direction:

```text
Icy blue / electric blue
```

Suggested tokens:

```css
--atlas-accent: #7DD3FC;
--atlas-accent-strong: #38BDF8;
--atlas-accent-deep: #0284C7;
```

Accent should be used selectively.

Good uses:

* active navigation
* links
* focused controls
* selected tabs
* important data
* interactive states
* system highlights
* CTAs
* diagram nodes

Do not turn every component blue.

---

# 7. Semantic Colors

Use semantic colors consistently.

Positive:

```text
Emerald / Green
```

Negative:

```text
Red
```

Warning:

```text
Amber
```

Neutral:

```text
Slate / Gray
```

Semantic colors should communicate meaning, never act as random decoration.

---

# 8. Grid System

The Atlas visual identity should strongly incorporate a modern grid.

Use responsive CSS Grid and consistent alignment throughout the application.

Desktop:

```text
12-column
```

Tablet:

```text
6-column
```

Mobile:

```text
1-column
```

All major content should align to a common container.

Suggested maximum width:

```text
1280–1440px
```

Suggested horizontal padding:

```text
24px mobile
32px tablet
48px desktop
```

Do not randomly position UI elements.

Alignment should feel intentional.

---

# 9. Signature Atlas Grid Background

Create a reusable Atlas technical-grid visual primitive.

Conceptually:

```text
┼──────┼──────┼──────┼──────┼
│      │      │      │      │
├──────┼──────┼──────┼──────┤
│      │      │      │      │
├──────┼──────┼──────┼──────┤
│      │      │      │      │
┼──────┼──────┼──────┼──────┼
```

Characteristics:

* extremely subtle
* low-opacity
* thin lines
* consistent spacing
* responsive
* should never overpower content

Suggested cell size:

```text
48–80px
```

Use the grid as a visual layer rather than a boxed component.

---

# 10. Grid Interaction

The Atlas grid can have subtle interactivity.

Possible behavior:

```text
Cursor
  ↓
local radial illumination
  +
nearby grid intersection becomes slightly brighter
```

This must be extremely subtle.

The effect should feel like the interface is responsive to the user, not like a visual gimmick.

Disable or simplify on mobile.

---

# 11. Background Composition

Preferred background hierarchy:

```text
Base graphite
      +
Subtle grid
      +
Very subtle radial gradient
      +
Content
```

Example:

```text
Layer 1 → #09090B
Layer 2 → technical grid at ~3–6% opacity
Layer 3 → radial accent glow at ~4–10% opacity
Layer 4 → content
```

Never make the entire background glow.

Never use large animated gradient blobs.

---

# 12. Borders

Borders are an important part of Atlas's design language.

Use thin:

```text
1px
```

low-opacity borders.

Borders should communicate:

* boundaries
* hierarchy
* grouping
* separation
* focus
* interaction

Prefer borders over heavy shadows.

---

# 13. Shadows

Use shadows minimally.

In dark mode, hierarchy should primarily come from:

* surface differences
* borders
* opacity
* spacing
* layering

instead of huge box shadows.

Stronger shadows are acceptable for:

* dialogs
* dropdowns
* command palettes
* floating elements

---

# 14. Radius

Use moderately rounded surfaces.

Recommended:

```text
sm → 6px
md → 10px
lg → 14px
xl → 18px
```

Avoid making everything perfectly pill-shaped.

Pills should be reserved for:

* status badges
* compact tags
* selected states where appropriate

---

# 15. Cards

Cards should NOT dominate the application.

When a card is appropriate:

* use subtle surface contrast
* thin border
* restrained radius
* generous but controlled spacing

Default card:

```text
background slightly above page background
border 1px
minimal shadow
```

Hover:

```text
border brightness increases
background shifts subtly
optional translateY(-1px)
```

Do not make every section a separate card.

Use open layouts whenever possible.

---

# 16. Components

Create a consistent component system.

Core primitives should include reusable versions of:

```text
Button
Badge
Card
Panel
Input
Select
Tabs
Tooltip
Dialog
Dropdown
Toast
Table
Metric
Status
Skeleton
Container
Section
Grid
```

The component system must feel coherent.

Do not allow individual pages to invent unrelated styling patterns.

---

# 17. Design Tokens

Centralize important design values.

Example:

```css
--atlas-background
--atlas-surface
--atlas-surface-elevated

--atlas-border
--atlas-border-strong

--atlas-text
--atlas-text-secondary
--atlas-text-muted
--atlas-text-disabled

--atlas-accent
--atlas-accent-strong
--atlas-accent-deep

--atlas-success
--atlas-warning
--atlas-danger

--atlas-radius-sm
--atlas-radius-md
--atlas-radius-lg

--atlas-shadow-sm
--atlas-shadow-md
```

All reusable components should consume these tokens.

Do not scatter arbitrary hex values throughout the codebase.

---

# 18. Buttons

Buttons should feel like financial infrastructure controls.

Primary:

* high contrast
* restrained
* compact
* clear hierarchy

Secondary:

* thin border
* subtle surface
* lower visual weight

Hover:

```text
150–250ms
slight upward movement
slightly brighter border
subtle background shift
```

Pressed:

```text
translateY(0)
scale(0.985)
```

Avoid excessive gradients.

Avoid giant pill buttons.

---

# 19. Form Controls

Inputs should feel precise and engineered.

Use:

* strong focus states
* clean borders
* restrained background
* clear error states
* clear disabled states

Focus:

```text
border accent
+
subtle focus ring
```

Do not use oversized glowing focus effects.

---

# 20. Tables

Tables should feel appropriate for financial software.

Use:

* compact rows
* strong column alignment
* tabular numbers
* subtle row separators
* sticky headers when appropriate
* hover state
* sorting
* filtering
* responsive overflow

Hover should be subtle.

Avoid turning tables into collections of cards.

---

# 21. Status Design

Atlas should use compact operational indicators.

Example:

```text
● Operational
● Processing
● Awaiting confirmation
● Settled
● Rejected
```

Use small indicators.

Avoid huge colored banners unless the situation genuinely demands one.

---

# 22. Loading States

Prefer skeleton interfaces over generic spinners.

Create reusable skeleton primitives.

Skeletons should match the actual final layout to prevent layout shifts.

Use spinners mainly for very short localized actions.

---

# 23. Toasts

Toasts should be:

* compact
* subtle
* informative
* actionable when useful

Example:

```text
✓ Transaction submitted
```

Optional action:

```text
[View]
```

No giant notifications.

---

# 24. Motion Philosophy

Motion is a core part of Atlas.

But motion must communicate intent.

Atlas motion should feel:

```text
Precise
Fast
Controlled
Technical
```

Never:

```text
Bouncy
Cartoonish
Exaggerated
Distracting
```

---

# 25. Motion Timing

Suggested durations:

```text
Micro interaction: 100–150ms
Standard interaction: 150–250ms
Component transition: 250–400ms
Page transition: 300–500ms
```

Preferred easing:

```text
cubic-bezier(0.22, 1, 0.36, 1)
```

Fast interactions should feel instantaneous without becoming abrupt.

---

# 26. Micro-interactions

Every important interaction should provide feedback.

Implement polished:

* hover states
* focus states
* pressed states
* selected states
* active indicators
* transitions
* loading states
* success states
* error states
* tooltip animations
* dropdown animations
* modal animations

Avoid animating everything.

---

# 27. Animated Indicators

For tabs and navigation, use animated active indicators rather than simply switching styles.

Example:

```text
Tab A
   ═══════►
Tab B
```

The indicator should smoothly travel to the selected item.

This should feel like one continuous interface rather than disconnected states.

---

# 28. Number Animation

For financial numbers, use controlled interpolation.

Examples:

* balance
* portfolio value
* price
* percentage
* volume

Do NOT animate every digit with dramatic effects.

Use smooth transitions that preserve readability.

High-frequency market data should not create visual chaos.

---

# 29. Data Visualization Style

Charts should feel professional.

Use:

* thin lines
* subtle gridlines
* precise tooltips
* crosshair
* restrained fills
* clean axes
* minimal legends

Avoid:

* excessive chart colors
* 3D graphics
* unnecessary decoration
* huge gradients
* excessive chart chrome

Charts should prioritize information.

---

# 30. Ambient Animation

Allowed ambient effects:

* very slow grid illumination
* subtle radial-gradient movement
* slow node pulse
* data flowing along a line
* small infrastructure signals
* subtle chart highlighting

Ambient motion must remain in the background.

The user should notice the polish before they consciously notice the animation.

---

# 31. Interactive Infrastructure Motif

Atlas should have a recurring visual concept around:

```text
Nodes
Rails
Connections
Data Flow
Grid
```

This should eventually be usable across many future products.

Example:

```text
●────────●────────●
     data flow →
```

Do not build pages around this motif now.

Instead, establish it as a reusable design primitive.

---

# 32. Reduced Motion

Support:

```text
prefers-reduced-motion
```

With reduced motion:

* remove unnecessary transforms
* remove ambient movement
* shorten transitions
* preserve functional feedback

Use Tailwind motion-safe/motion-reduce utilities where appropriate.

---

# 33. Navigation

Navigation should feel lightweight and engineered.

Use:

* clear hierarchy
* subtle hover states
* active indicators
* restrained borders
* smooth dropdowns

Desktop navigation can become slightly elevated after scrolling.

Do not make the navbar oversized.

---

# 34. Dropdowns

Opening:

```text
opacity 0 → 1
scale 0.98 → 1
translateY(-4px) → 0
```

Duration:

```text
150–200ms
```

Closing can be slightly faster.

Dropdown surfaces should have:

* thin borders
* restrained shadows
* subtle surface contrast

---

# 35. Dialogs

Dialogs should feel calm and precise.

Opening:

```text
backdrop fade
+
content scale 0.98 → 1
+
slight translate
```

Do not use dramatic zoom animations.

---

# 36. Glassmorphism

Use sparingly.

Acceptable:

* sticky navigation
* command palette
* floating overlays
* modal backdrops

Do not make the complete interface glassmorphic.

Atlas should primarily be based on:

```text
solid surfaces
+
borders
+
grid
+
typography
```

---

# 37. Spacing

Use a disciplined spacing scale.

Avoid arbitrary margins everywhere.

Recommended base:

```text
4px increments
```

with larger structural spacing using:

```text
8
12
16
24
32
48
64
96
128
```

Large spacing should be used intentionally to establish hierarchy.

---

# 38. Responsive System

Design desktop and mobile deliberately.

Desktop:

* spacious
* multi-column
* high information density where appropriate

Tablet:

* compressed
* adaptive grids

Mobile:

* stacked layouts
* touch-friendly controls
* intentional navigation
* horizontally scrollable data where necessary

Never simply shrink desktop UI.

---

# 39. Accessibility

Mandatory:

* semantic HTML
* keyboard navigation
* visible focus states
* sufficient contrast
* accessible labels
* ARIA when necessary
* reduced-motion support
* touch targets of approximately 44px where applicable
* never rely only on color to communicate state

Premium UI must still be accessible UI.

---

# 40. Performance

Motion must not degrade performance.

Prefer animating:

```text
transform
opacity
```

and GPU-friendly properties.

Avoid unnecessary animation of:

```text
width
height
top
left
```

Avoid expensive filter animations unless essential.

Lazy-load expensive visualizations.

Do not ship large visual assets purely for decoration.

---

# 41. Technical Stack

Preferred:

```text
Next.js
React
TypeScript
Tailwind CSS
shadcn/ui
Lucide
Motion for React / Framer Motion
```

Use Tailwind for the design system.

Use CSS for simple transitions.

Use Motion for:

* layout transitions
* shared-layout interactions
* page transitions
* complex state transitions
* orchestrated motion
* animated indicators

Do not install libraries unnecessarily.

---

# 42. Tailwind Architecture

Tailwind should be used systematically.

Do NOT create huge repeated utility strings everywhere.

Create reusable variants and primitives.

Examples:

```text
AtlasButton
AtlasCard
AtlasPanel
AtlasBadge
AtlasStatus
AtlasGrid
AtlasMetric
AtlasTable
AtlasTabs
AtlasDialog
AtlasToast
```

Shared primitives should establish consistency across the entire application.

---

# 43. Avoid AI-Generated UI Patterns

Explicitly avoid the visual patterns commonly produced by AI-generated websites:

* excessive cards
* huge centered headings
* purple-blue gradients everywhere
* giant glow effects
* random floating circles
* excessive rounded corners
* meaningless metrics
* decorative terminal text with no purpose
* generic testimonials
* stock-style illustrations
* arbitrary icons
* excessive glassmorphism

Atlas should look like an engineer-designed financial platform.

---

# 44. Content Tone

Use concise, confident language.

Avoid marketing fluff.

Avoid:

> Supercharge your financial journey with our revolutionary next-generation platform.

Prefer:

> Financial infrastructure for digital markets.

Language should be:

* direct
* technical
* confident
* restrained

---

# 45. Visual Density

Atlas needs to support different visual densities depending on context.

Marketing / informational surfaces:

```text
spacious
```

Application surfaces:

```text
compact
precise
information-rich
```

Do not force one spacing style across the entire product.

---

# 46. Branding

Wordmark:

```text
ATLAS
```

Potential symbol direction:

* abstract A
* coordinate intersection
* connected nodes
* axis/compass concept
* geometric structure

Do not use a literal globe icon.

The brand mark should work at:

* favicon
* navbar
* loading state
* application shell
* documentation
* future products

---

# 47. Design Continuity

The most important goal is consistency.

A user should be able to encounter a completely new Atlas feature in the future and immediately recognize:

> "This belongs to Atlas."

This should be achieved through:

* typography
* spacing
* grid
* borders
* colors
* motion
* component language
* icon language
* data presentation

not through repeating the same exact layouts.

---

# 48. Implementation Rules for Claude

Before changing UI:

1. Inspect the existing codebase.
2. Understand the current components.
3. Identify duplicated styles.
4. Identify inconsistent spacing.
5. Identify inconsistent colors.
6. Identify generic components.
7. Preserve existing functionality.
8. Preserve routing.
9. Preserve API integrations.
10. Preserve state management.
11. Preserve backend behavior.
12. Preserve authentication.
13. Preserve business logic.

Then introduce the Atlas design system progressively.

Do NOT rewrite working functionality simply to change appearance.

---

# 49. Refactoring Rules

If a component is too large:

> Split it.

If multiple components duplicate visual logic:

> Extract a shared primitive.

If styling is inconsistent:

> Move it into tokens or reusable variants.

If animation is repeated:

> Create a reusable motion primitive.

If an effect exists only for one meaningful interaction:

> Keep it local.

The resulting code must remain maintainable.

---

# 50. Quality Bar

The final interface should feel like:

> A company that could responsibly manage billions in financial infrastructure.

It should not feel like:

> A polished student crypto project.

The standard is:

```text
Premium
+
Technical
+
Institutional
+
Minimal
+
Fast
+
Trustworthy
```

---

# 51. Final Design Rule

Do not interpret this document as:

> "Add more animations and gradients."

Interpret it as:

> "Create a coherent visual system with world-class interaction quality."

The objective is not to make Atlas flashy.

The objective is to make Atlas feel **inevitable, precise, and professionally engineered**.

---

# 52. Tailwind Reference

Use the official Tailwind CSS website as a visual-quality reference for:

* grid composition
* typography
* whitespace
* responsive design
* gradients
* subtle borders
* animation
* transition quality

Do not copy the Tailwind brand identity or exact layouts.

Reference:

https://tailwindcss.com/

https://tailwindcss.com/docs/animation

https://tailwindcss.com/docs/transition-property
