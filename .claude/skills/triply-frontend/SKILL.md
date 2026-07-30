# Triply Frontend Design System

> Reference for all UI work in the Triply codebase. Follow these patterns exactly to maintain visual and structural consistency.

---

## Brand Identity

| Token | Value | Tailwind Class |
|-------|-------|----------------|
| Primary (Coral) | `#f87356` | `bg-brand-orange`, `text-brand-orange`, `border-brand-orange` |
| Secondary (Navy) | `#1A1A2E` | `bg-brand-dark`, `text-brand-dark` |
| Accent Blue | `#3b82f6` | `bg-brand-blue`, `text-brand-blue` |
| Light Gray BG | `#f8fafc` | `bg-brand-gray` |
| Text (Dark Slate) | `#1e293b` | `text-foreground` (via CSS var) |
| Muted Text | `#64748b` | `text-muted-foreground` |
| Success | `#22c55e` | `text-green-600`, `bg-green-50` |
| Warning | `#f59e0b` | `text-amber-600`, `bg-amber-50` |
| Error | `#ef4444` | `text-red-600`, `bg-red-50` |

### When to Use Each Color

- **brand-orange**: Primary CTAs, active states, focus rings, links, price highlights, brand accents
- **brand-dark**: Footer background, dark sections, navbar text
- **brand-blue**: Informational icons, secondary accents
- **brand-gray**: Page backgrounds, section alternation
- **gray-900**: Headings
- **gray-700 / gray-600**: Body text
- **gray-500 / gray-400**: Muted/helper text, placeholder text, inactive icons
- **gray-200 / gray-100**: Borders, dividers, subtle backgrounds

---

## Typography

### Fonts

| Purpose | Font | CSS Variable | Tailwind |
|---------|------|-------------|----------|
| Headings | Poppins (Bold) | `--font-poppins` | Applied automatically via `@layer base` |
| Body | Inter (Regular) | `--font-inter` | `font-sans` (default) |
| Monospace | Geist Mono | `--font-geist-mono` | `font-mono` |

### Heading Rules (auto-applied via globals.css)

All `h1`-`h6` elements automatically get: `font-family: Poppins; font-bold; tracking-tight;`

### Text Size Scale

| Element | Classes |
|---------|---------|
| Hero heading | `text-4xl md:text-6xl font-bold` |
| Page title | `text-2xl md:text-3xl font-bold` |
| Section heading | `text-xl md:text-2xl font-bold` |
| Card title | `text-lg font-semibold` or `text-xl font-bold` |
| Body text | `text-base` (default) |
| Secondary text | `text-sm text-gray-600` |
| Labels / captions | `text-xs text-gray-500` |
| Overline / tag | `text-xs font-semibold uppercase tracking-wide` |

### Text Colors by Context

| Context | Class |
|---------|-------|
| Primary heading | `text-gray-900` |
| Body paragraph | `text-gray-700` or `text-gray-600` |
| Muted/secondary | `text-gray-500` |
| Placeholder | `text-gray-400` |
| Links | `text-brand-orange hover:text-orange-600` |
| On dark bg | `text-white` |
| On dark bg muted | `text-gray-400` |
| Price | `text-gray-900 font-bold` |
| Old price | `text-gray-400 line-through text-sm` |

---

## Spacing System

### Standard Spacing Values

Use Tailwind's default 0.25rem (4px) scale. Common values used in this codebase:

| Token | Value | Common Usage |
|-------|-------|-------------|
| `1` | 4px | Icon gaps, tight spacing |
| `2` | 8px | Badge padding, small gaps |
| `3` | 12px | Input icon padding, inner gaps |
| `4` | 16px | Card padding (tight), field gaps |
| `6` | 24px | Card padding (standard), section gaps |
| `8` | 32px | Section padding, large gaps |
| `12` | 48px | Major section separation |
| `16` | 64px | Section vertical padding (mobile) |
| `20` | 80px | Section vertical padding (desktop), pt for navbar clearance |

### Container & Page Padding

```
Responsive horizontal padding: px-4 sm:px-6 lg:px-8
Section vertical padding:       py-16 lg:py-20
Navbar clearance:                pt-20
```

### Max-Width by Page Type

| Page Type | Max Width | Usage |
|-----------|-----------|-------|
| Wide (search, checkout, lot detail) | `max-w-7xl` (80rem) | Multi-column layouts |
| Medium (confirmation) | `max-w-5xl` (64rem) | Two-column layouts |
| Narrow (help, contact, account, reservations) | `max-w-4xl` (56rem) | Single-column content |
| Blog post | `max-w-3xl` (48rem) | Long-form reading |
| Hero search box | `max-w-5xl` (64rem) | Centered hero content |

### Standard Section Wrapper

```tsx
<section className="py-16 lg:py-20 bg-white">
  <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
    {/* Content */}
  </div>
</section>
```

---

## Layout Patterns

### Page Structure

Every page follows this skeleton:

```tsx
<div className="min-h-screen bg-white">  {/* or bg-gray-50 */}
  <Navbar forceSolid={true} />  {/* forceSolid=false only on homepage */}
  <main className="pt-20">
    {/* Page header (optional) */}
    <div className="bg-white border-b border-gray-200">
      <div className="max-w-[SIZE] mx-auto px-4 py-8">
        {/* Icon + Title + Subtitle */}
      </div>
    </div>
    {/* Main content */}
    <div className="max-w-[SIZE] mx-auto px-4 py-8">
      {/* Content */}
    </div>
  </main>
  <Footer />
</div>
```

### Grid Patterns

**Sidebar layout (checkout, lot detail):**
```tsx
<div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
  <div className="lg:col-span-2">{/* Main content */}</div>
  <div>{/* Sidebar - sticky top-24 */}</div>
</div>
```

**Split view (search results):**
```tsx
<div className="flex-1 flex overflow-hidden">
  <div className="w-full lg:w-2/5">{/* List */}</div>
  <div className="hidden lg:block w-3/5">{/* Map */}</div>
</div>
```

**Equal columns (confirmation):**
```tsx
<div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
```

**Feature grid (homepage):**
```tsx
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
```

**Form fields:**
```tsx
<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
```

**Hero search bar:**
```tsx
<div className="grid grid-cols-1 md:grid-cols-12 gap-4">
  <div className="md:col-span-4">{/* Location */}</div>
  <div className="md:col-span-3">{/* Depart */}</div>
  <div className="md:col-span-3">{/* Return */}</div>
  <div className="md:col-span-2">{/* Button */}</div>
</div>
```

### Responsive Breakpoints

| Breakpoint | Width | Usage |
|------------|-------|-------|
| (base) | 0px+ | Mobile-first styles |
| `sm:` | 640px+ | Form field grids (1 -> 2 cols) |
| `md:` | 768px+ | Tablet nav, hero layout, content grids |
| `lg:` | 1024px+ | Desktop sidebar layouts, map visibility |
| `xl:` | 1280px+ | Search header inline layout |

---

## Component Patterns

### Card

```tsx
<div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
```

With hover elevation:
```tsx
<div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm
                hover:shadow-lg hover:border-brand-orange/30 transition-all">
```

### Buttons

**Primary CTA:**
```tsx
<button className="w-full bg-brand-orange text-white font-bold py-3.5 rounded-lg
                   hover:bg-orange-600 transition-all shadow-md active:scale-[0.98]">
```

**Secondary / Outline:**
```tsx
<button className="border border-gray-300 rounded-lg text-gray-700 px-4 py-2
                   hover:bg-gray-50 transition-colors">
```

**Nav sign-in (pill):**
```tsx
<Button className="bg-brand-orange text-white px-5 py-2 rounded-full
                   hover:bg-orange-600 transition-all">
```

**Disabled state (always add):**
```tsx
disabled={isLoading}
className="... disabled:opacity-50 disabled:cursor-not-allowed"
```

### Form Inputs

**Standard input:**
```tsx
<input
  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg
             focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none"
/>
```

**Input with icon:**
```tsx
<div className="relative">
  <Mail size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
  <input className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg
                    focus:ring-2 focus:ring-brand-orange focus:border-transparent" />
</div>
```

**Input with error:**
```tsx
<input className={`w-full px-4 py-2.5 border rounded-lg focus:ring-2 focus:ring-brand-orange
                   focus:border-transparent outline-none
                   ${errors.field ? "border-red-500" : "border-gray-300"}`} />
{errors.field && <p className="text-red-500 text-xs mt-1">{errors.field}</p>}
```

**Label:**
```tsx
<label className="block text-sm font-medium text-gray-700 mb-1">
  Label <span className="text-red-500">*</span>
</label>
```

**Select with custom chevron:**
```tsx
<div className="relative">
  <select className="w-full px-4 py-2.5 border border-gray-300 rounded-lg appearance-none
                     focus:ring-2 focus:ring-brand-orange focus:border-transparent">
    <option>...</option>
  </select>
  <ChevronDown size={16} className="absolute right-3 top-1/2 -translate-y-1/2
                                     text-gray-400 pointer-events-none" />
</div>
```

### Status Badges

```tsx
// Success
<span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium
                 bg-green-100 text-green-800">Active</span>

// Warning
<span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium
                 bg-amber-100 text-amber-800">Pending</span>

// Error
<span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium
                 bg-red-100 text-red-800">Cancelled</span>

// Neutral
<span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium
                 bg-gray-100 text-gray-800">Completed</span>
```

### Alert / Notice Boxes

**Error alert:**
```tsx
<div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
  <AlertCircle size={18} className="text-red-600 flex-shrink-0 mt-0.5" />
  <div className="text-sm">
    <span className="font-semibold text-red-800">Error Title</span>
    <p className="text-red-700 text-xs mt-0.5">{message}</p>
  </div>
</div>
```

**Warning/info alert:**
```tsx
<div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
  <Wallet size={18} className="text-amber-600 flex-shrink-0" />
  <div className="text-sm">
    <span className="font-semibold text-amber-800">Notice</span>
    <p className="text-amber-700 text-xs mt-0.5">{message}</p>
  </div>
</div>
```

### Sticky Sidebar

```tsx
<div className="sticky top-24">  {/* 24 = navbar height offset */}
  <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
    {/* Sidebar content */}
  </div>
</div>
```

### Price Display

```tsx
<div className="flex items-baseline gap-1">
  <span className="text-sm text-gray-400 line-through">${originalPrice}</span>
  <span className="text-xl font-bold text-gray-900">${salePrice}</span>
  <span className="text-xs text-gray-500 font-normal">/day</span>
</div>
```

---

## Loading & Error States

### Skeleton Loading

```tsx
<div className="w-24 h-10 bg-gray-200 animate-pulse rounded-full" />
```

### Spinner

```tsx
<div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-orange" />
```

Or with Lucide:
```tsx
<Loader2 size={20} className="animate-spin" />
```

### Button Loading State

```tsx
<button disabled={isSubmitting} className="... disabled:opacity-50 disabled:cursor-not-allowed">
  {isSubmitting ? (
    <>
      <Loader2 size={20} className="animate-spin" />
      Processing...
    </>
  ) : (
    <>
      <Check size={20} />
      Complete Booking
    </>
  )}
</button>
```

### Page Loading Spinner

```tsx
<div className="min-h-screen flex items-center justify-center">
  <div className="text-center">
    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-orange mx-auto" />
    <p className="mt-4 text-gray-600">Loading...</p>
  </div>
</div>
```

---

## Hover & Interaction Patterns

### Card Hover (elevation + color hint)

```tsx
className="hover:shadow-lg hover:border-brand-orange/30 transition-all"
```

### Card Hover (lift effect)

```tsx
className="hover:shadow-xl hover:-translate-y-1 transition-all duration-500"
```

### Icon on Hover (scale within group)

```tsx
<div className="group">
  <div className="group-hover:scale-110 transition-transform duration-300">
    <Icon />
  </div>
  <h3 className="group-hover:text-brand-orange transition-colors">Title</h3>
</div>
```

### Link Hover

```tsx
className="text-gray-400 hover:text-white transition-colors"  // Footer
className="text-gray-600 hover:text-brand-orange transition-colors"  // Navigation
```

### Button Active Feedback

```tsx
className="active:scale-95"    // Strong press
className="active:scale-[0.98]"  // Subtle press
```

### Focus Ring (forms)

```tsx
className="focus:ring-2 focus:ring-brand-orange focus:border-transparent"
```

### Focus Ring (shadcn components)

```tsx
className="focus-visible:ring-ring/50 focus-visible:ring-[3px]"
```

---

## Animation Classes

| Class | Effect | Duration |
|-------|--------|----------|
| `animate-fade-in` | Fade in + slide up 10px | 0.5s ease-out |
| `animate-fade-in-up` | Fade in + slide up 20px | 0.6s ease-out |
| `animate-slide-in-right` | Slide from right | 0.3s ease-out |
| `animate-subtle-pulse:hover` | Gentle scale pulse on hover | 2s infinite |
| `animate-spin` | Continuous rotation (Tailwind built-in) | - |
| `animate-pulse` | Opacity pulse (Tailwind built-in) | - |
| `stagger-1` through `stagger-4` | Delay 0.1s-0.4s | - |
| `animate-on-scroll` + `.visible` | Scroll-triggered fade-in-up | 0.6s |

### Staggered Grid Items

```tsx
{items.map((item, index) => (
  <div
    key={index}
    className="animate-fade-in-up opacity-0"
    style={{ animationDelay: `${index * 100}ms`, animationFillMode: "forwards" }}
  >
    {/* Card */}
  </div>
))}
```

---

## Transition Classes

Always add transition classes to interactive elements:

```tsx
transition-all       // General (hover elevation + color + transform)
transition-colors    // Color-only changes (links, nav items)
transition-transform // Scale/translate only
transition-opacity   // Visibility changes
duration-300         // Standard (default if omitted)
duration-500         // Slower (card hovers, feature cards)
```

---

## Icons

**Library**: `lucide-react`

### Common Sizes

| Context | Size |
|---------|------|
| Inline with text | `size={16}` or `size-4` |
| Form input icons | `size={18}` |
| Button icons | `size={20}` |
| Feature/empty state | `size={24}` or larger |

### Frequently Used Icons

| Icon | Usage |
|------|-------|
| `Plane` | Brand/logo |
| `Menu`, `X` | Mobile menu toggle |
| `ChevronDown`, `ChevronRight` | Dropdowns, accordions, navigation |
| `User`, `LogOut` | Auth/account |
| `Mail`, `Phone` | Contact form inputs |
| `Calendar`, `Clock` | Date/time fields |
| `Shield` | Trust/security badges |
| `Star` | Ratings |
| `MapPin` | Location |
| `Car` | Vehicle info |
| `Check`, `CheckCircle` | Success states, amenities |
| `AlertCircle` | Error states |
| `Loader2` | Loading spinners (with `animate-spin`) |
| `Heart`, `Share2` | Save/share actions |
| `Ticket` | Reservations |
| `Search` | Search functionality |
| `ArrowRight`, `ArrowLeft` | Navigation, CTAs |

---

## shadcn/ui Configuration

| Setting | Value |
|---------|-------|
| Style | `new-york` |
| Base color | `neutral` |
| CSS variables | `true` |
| Icon library | `lucide` |
| RSC | `true` |
| Base radius | `0.625rem` (10px) |

### Installed Components

accordion, avatar, badge, button, calendar, card, checkbox, command, dialog, dropdown-menu, form, input, label, popover, select, separator, sheet, skeleton, sonner, tabs, textarea

### Utility Function

```tsx
import { cn } from "@/lib/utils";  // clsx + tailwind-merge
```

Always use `cn()` when conditionally composing classes:
```tsx
className={cn(
  "base-classes",
  condition && "conditional-classes",
  variant === "active" && "active-classes"
)}
```

---

## Component Architecture Rules

### Client vs Server Components

- **Default to Server Components** for static content, layouts, and pages that just fetch + render
- **Use `"use client"` only when needed**: useState, useEffect, event handlers, browser APIs
- Pages with `useSearchParams` or forms must be Client Components

### Props Patterns

```tsx
interface ComponentNameProps {
  requiredProp: string;
  optionalProp?: boolean;
  onAction: (id: string) => void;  // Explicit callback typing
  children?: React.ReactNode;
}

export function ComponentName({ requiredProp, optionalProp = false, onAction }: ComponentNameProps) {
```

### State Management

- `useState` for local component state
- `useMemo` for expensive derived values
- `useEffect` for side effects (data fetching, event listeners)
- Props drilling with typed callbacks for parent-child communication
- `sessionStorage` for cross-page data persistence (e.g., lot data during checkout)
- No external state management library (no Redux, Zustand, etc.)

### File Naming

| Type | Convention | Example |
|------|-----------|---------|
| Components | kebab-case | `lot-card.tsx`, `booking-widget.tsx` |
| Component exports | PascalCase | `export function LotCard()` |
| Utilities | camelCase | `formatPrice.ts` |
| Types/interfaces | PascalCase + suffix | `LotCardProps`, `BookingType` |

### Directory Structure

```
src/components/
├── shared/       # Navbar, Footer, Hero, marketing sections
├── search/       # Search results page components
├── lot/          # Lot detail page components
├── checkout/     # Multi-step checkout components
├── confirmation/ # Post-booking components
├── reservations/ # User reservations
├── blog/         # Blog rendering
├── email/        # Email templates
└── ui/           # shadcn/ui primitives (do not manually edit)
```

---

## Dark Section Pattern (Footer Style)

```tsx
<footer className="bg-brand-dark text-white">
  <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
    {/* Grid of link columns */}
    <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
      {/* ... */}
    </div>
    {/* Divider */}
    <div className="border-t border-gray-800 mt-12 pt-8">
      {/* Copyright */}
    </div>
  </div>
</footer>
```

Text on dark: `text-white` for headings, `text-gray-400` for muted, `hover:text-white` or `hover:text-brand-orange` for links.

---

## Accordion / FAQ Pattern

```tsx
<div className={`bg-white rounded-xl overflow-hidden border transition-all ${
  isOpen ? "border-brand-orange shadow-md" : "border-gray-200"
}`}>
  <button onClick={toggle} className="w-full flex justify-between items-center p-6 text-left">
    <span className="font-semibold text-gray-900">{question}</span>
    <ChevronDown className={`transition-transform ${isOpen ? "rotate-180 text-brand-orange" : "text-gray-400"}`} />
  </button>
  <div className={`px-6 transition-all duration-300 overflow-hidden ${
    isOpen ? "max-h-40 pb-6 opacity-100" : "max-h-0 opacity-0"
  }`}>
    <p className="text-gray-600">{answer}</p>
  </div>
</div>
```

---

## Border Radius Scale

| Class | Usage |
|-------|-------|
| `rounded` | Small elements (inner chips) |
| `rounded-md` | shadcn inputs |
| `rounded-lg` | Buttons, inputs, form controls |
| `rounded-xl` | Cards, panels, containers |
| `rounded-2xl` | Hero search box, large containers |
| `rounded-full` | Badges, pills, avatars, nav buttons |

---

## Shadow Scale

| Class | Usage |
|-------|-------|
| `shadow-sm` | Cards at rest |
| `shadow-md` | Buttons, elevated components |
| `shadow-lg` | Card hover state, dropdowns |
| `shadow-xl` | Strong hover elevation |
| `drop-shadow-lg` | Text over images |

---

## Z-Index Scale

| Value | Usage |
|-------|-------|
| `z-10` | Overlay backdrop (click-away) |
| `z-20` | Dropdown menus |
| `z-30` | Sticky search headers |
| `z-50` | Navbar, modals, lightboxes |

---

## Responsive Patterns Summary

**Mobile-first approach.** Base styles are mobile, enhanced with breakpoint prefixes.

```tsx
// Stacked -> row
className="flex flex-col sm:flex-row gap-4"

// 1 col -> 2 col -> 4 col grid
className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6"

// Hide on mobile, show on desktop
className="hidden lg:block"

// Responsive font size
className="text-2xl md:text-4xl lg:text-6xl"

// Responsive padding
className="px-4 sm:px-6 lg:px-8"

// Responsive section spacing
className="py-12 lg:py-20"
```

---

## Anti-Patterns (Do NOT)

- Do NOT use inline styles for colors, spacing, or typography — use Tailwind classes
- Do NOT hardcode hex colors — use `brand-orange`, `brand-dark`, or gray scale classes
- Do NOT use `px` values directly — use Tailwind spacing scale
- Do NOT create new CSS files — all styles go through Tailwind utilities
- Do NOT manually edit files in `src/components/ui/` — those are shadcn-managed
- Do NOT use `margin-top` for section spacing between components — use `gap-*` or `space-y-*` on the parent
- Do NOT use arbitrary values (`[32px]`) when a Tailwind class exists (`p-8`)
- Do NOT skip `transition-*` classes on interactive elements
- Do NOT skip `disabled:opacity-50 disabled:cursor-not-allowed` on buttons
- Do NOT use raw `<button>` without proper hover/focus/disabled states
- Do NOT import fonts manually — they are configured in root `layout.tsx` via `next/font/google`
