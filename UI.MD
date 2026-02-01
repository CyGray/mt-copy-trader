# Marine Trader UI/UX Design System & Implementation Guide

## Executive Summary

This document provides a comprehensive UI/UX redesign strategy for the Marine Trader crypto bot dashboard. The current implementation suffers from:
- Visual clutter with excessive information density
- Inconsistent spacing and visual hierarchy
- Redundant status indicators
- Poor mobile responsiveness
- Cognitive overload from simultaneous data presentation

The redesign focuses on **progressive disclosure**, **data density optimization**, **micro-interactions**, and **visual clarity** to create a professional, scalable trading dashboard that maximizes user satisfaction and operational efficiency.

---

## Table of Contents

1. [Design Principles](#1-design-principles)
2. [Industry Standards & Best Practices](#2-industry-standards--best-practices)
3. [Visual Hierarchy & Information Architecture](#3-visual-hierarchy--information-architecture)
4. [Component Library & Design Tokens](#4-component-library--design-tokens)
5. [Page-by-Page Redesign Strategy](#5-page-by-page-redesign-strategy)
6. [Human Psychology & UX Patterns](#6-human-psychology--ux-patterns)
7. [Accessibility & Performance](#7-accessibility--performance)
8. [Implementation Checklist](#8-implementation-checklist)
9. [Claude Opus 4.5 Implementation Prompt](#9-claude-opus-45-implementation-prompt)

---

## 1. Design Principles

### Core Pillars

1. **Information at a Glance**: Critical metrics visible in <3 seconds (Hick's Law)
2. **Progressive Disclosure**: Advanced features hidden behind intentional interactions
3. **Cognitive Load Reduction**: Max 7±2 information units per view (Miller's Law)
4. **Fitts's Law Compliance**: Primary actions large and accessible
5. **Aesthetic-Usability Effect**: Beauty = perceived ease of use

### Design Values

- **Clarity > Decoration**: Every pixel serves a purpose
- **Consistency > Novelty**: Predictable patterns across all views
- **Speed > Features**: Fast load times and instant feedback
- **Trust > Flash**: Professional, reliable visual language

---

## 2. Industry Standards & Best Practices

### Trading Dashboard Benchmarks

**Reference Systems**: Bloomberg Terminal, TradingView, Binance Pro, Interactive Brokers

#### Key Patterns to Adopt:

1. **Compact Data Tables**
   - Fixed header rows
   - Zebra striping for readability
   - Inline actions on hover
   - Sortable columns with clear indicators

2. **Status Visualization**
   - Color-coded pill badges (green/amber/red)
   - Icon + text for redundancy
   - Subtle pulse animations for critical alerts

3. **Metric Cards**
   - Large number with small label
   - Trend indicators (↑↓ with %)
   - Comparison period (24h, 7d)
   - Sparkline charts for context

4. **Navigation Patterns**
   - Persistent sidebar (desktop)
   - Bottom tab bar (mobile)
   - Breadcrumbs for depth
   - Quick actions in header

### Typography Scale (Tailwind)

```
Display: text-4xl (36px) - Hero numbers
Heading 1: text-2xl (24px) - Page titles
Heading 2: text-lg (18px) - Section headers
Heading 3: text-base (16px) - Card titles
Body: text-sm (14px) - Primary text
Caption: text-xs (12px) - Labels, metadata
Micro: text-[10px] (10px) - Timestamps, badges
```

### Spacing System

```
Micro: 4px (gap-1) - Icon spacing
Compact: 8px (gap-2) - Input padding
Base: 12px (gap-3) - Card padding
Comfortable: 16px (gap-4) - Section spacing
Loose: 24px (gap-6) - Page margins
```

---

## 3. Visual Hierarchy & Information Architecture

### Z-Pattern Layout (Dashboard)

```
┌─────────────────────────────────────┐
│ [Logo] [Quick Stats]      [Actions]│ ← Primary scan line
├─────────────────────────────────────┤
│ ┌────────────┐  ┌────────────────┐ │
│ │ Status     │  │ Activity Feed  │ │ ← Secondary content
│ │ Cards      │  │                │ │
│ └────────────┘  └────────────────┘ │
└─────────────────────────────────────┘
```

### F-Pattern Layout (Data Tables)

```
┌──────────────────────────────────────┐
│ [Filters] [Search] ──────────────    │ ← Horizontal scan
│ ═══════════════════════════════════  │ ← Table header
│ Long entry ────────────────────────  │ ← First items
│ Short entry ──────────                │
│ Medium entry ─────────────────        │
└──────────────────────────────────────┘
```

### Information Prioritization

**Tier 1 (Always Visible):**
- System health status
- Active positions count
- Last signal received
- Critical alerts

**Tier 2 (Above Fold):**
- Recent activity (5 items)
- Session status cards
- Quick actions

**Tier 3 (Scroll/Expand):**
- Detailed logs
- Configuration options
- Historical data

---

## 4. Component Library & Design Tokens

### Color Palette

```typescript
// Brand Colors
marine-navy: #0A2540      // Primary (headers, active states)
marine-blue: #1E40AF      // Interactive elements
marine-mist: #F0F4F8      // Backgrounds
marine-accent: #3B82F6    // Highlights

// Semantic Colors
success: #10B981          // Green (profitable, healthy)
warning: #F59E0B          // Amber (attention needed)
danger: #EF4444           // Red (critical, losing)
neutral: #6B7280          // Gray (inactive, disabled)

// Data Visualization
chart-up: #22C55E         // Bullish/gains
chart-down: #F43F5E       // Bearish/losses
chart-neutral: #94A3B8    // Sideways/neutral
```

### Component Inventory

#### 1. **MetricCard**
```tsx
Props: label, value, trend, trendValue, icon, variant
Usage: Dashboard KPIs
Size: 120px × 100px (compact)
```

#### 2. **StatusBadge**
```tsx
Props: status, pulse, size
Variants: success, warning, danger, neutral
```

#### 3. **CompactTable**
```tsx
Features: Sticky header, hover actions, zebra striping
Max height: 400px with scroll
```

#### 4. **ActivityItem**
```tsx
Props: timestamp, message, type, metadata
Layout: Timestamp left, message right, type badge
```

#### 5. **QuickAction**
```tsx
Props: label, icon, onClick, variant
Size: 40px circle (mobile), Auto width (desktop)
```

#### 6. **FormField**
```tsx
Props: label, value, onChange, error, hint
Variants: text, number, select, toggle
```

### Animation Tokens

```typescript
transition-fast: 150ms       // Hover states
transition-base: 300ms       // Modal open/close
transition-slow: 500ms       // Page transitions

easing-standard: ease-in-out
easing-enter: ease-out
easing-exit: ease-in

pulse: 2s infinite          // Critical alerts
fade-in: 0.3s ease-out
slide-up: 0.4s ease-out
```

---

## 5. Page-by-Page Redesign Strategy

### 5.1 Dashboard (Overview)

**Current Issues:**
- Too many large cards
- Redundant session information
- Mixed priority levels in same visual weight

**Redesign Strategy:**

```
┌──────────────────────────────────────────────────┐
│ ⚡ System Healthy  │  3 Active  │  BTCUSDT 🟢    │ ← Status Bar (60px)
├──────────────────────────────────────────────────┤
│ ┌─────────┬─────────┬─────────┬─────────┐      │
│ │  24h    │  Open   │  P&L    │  Signals│      │ ← Metric Row (100px)
│ │  +2.3%  │   3     │ +$234   │    12   │      │
│ └─────────┴─────────┴─────────┴─────────┘      │
├──────────────────────────────────────────────────┤
│ ┌──────────────┐  ┌──────────────────────────┐ │
│ │ Quick        │  │ Recent Activity (Feed)   │ │
│ │ Actions      │  │ • May 02 05:36 pm        │ │
│ │              │  │   ETHUSDT LONG detected  │ │
│ │ [Kill]       │  │ • May 02 05:22 pm        │ │
│ │ [Paper]      │  │   Position opened BTCUSDT│ │
│ │ [Refresh]    │  │ • May 02 05:15 pm        │ │
│ └──────────────┘  │   TP1 hit +$45.20        │ │
│                   └──────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

**Improvements:**
- Condensed status bar (60px height)
- 4 metric cards in single row (25% width each)
- Activity feed with timeline design
- Quick actions grouped in sidebar

---

### 5.2 Logs Page

**Current Issues:**
- Large log cards waste vertical space
- Timestamps not scannable
- No log severity visual distinction

**Redesign Strategy:**

```
┌──────────────────────────────────────────────────┐
│ [Telegram] [System] [Errors]    🔍 [__________]  │ ← Tab + Search (48px)
├──────────────────────────────────────────────────┤
│ Time     │ Source      │ Message               │ │ ← Table Header
│══════════│═════════════│═══════════════════════│ │
│ 05:36 pm │ 🟢 Signals  │ BTCUSDT LONG detected │ │ ← Row 1 (32px)
│ 05:22 pm │ 🟡 Worker   │ Rate limit warning    │ │ ← Row 2
│ 05:15 pm │ 🟢 Bybit    │ Position opened       │ │ ← Row 3
│ ...      │             │                       │ │
└──────────────────────────────────────────────────┘
```

**Improvements:**
- Table format (80% more space efficient)
- Color-coded severity dots
- Condensed timestamps (no date if today)
- Infinite scroll instead of pagination

---

### 5.3 Settings Page

**Current Issues:**
- Too many form fields visible at once
- No grouping or prioritization
- Chat ID management cumbersome

**Redesign Strategy:**

```
┌──────────────────────────────────────────────────┐
│ [Trading ▼] [Telegram] [Advanced]               │ ← Accordion Tabs
├──────────────────────────────────────────────────┤
│ Risk Management                                  │
│ ┌─────────────┬─────────────┐                   │
│ │ Risk Mode ▼ │ Value: $20  │                   │
│ └─────────────┴─────────────┘                   │
│                                                  │
│ Position Limits                                  │
│ Max open: [3]  Per symbol: [1]                  │
│                                                  │
│ Safety Toggles                                   │
│ ○ Paper Mode  ● Kill Switch                     │
├──────────────────────────────────────────────────┤
│                          [Cancel] [Save Changes] │
└──────────────────────────────────────────────────┘
```

**Improvements:**
- Accordion sections (collapsed by default)
- Inline labels (50% space reduction)
- Toggle switches for booleans
- Floating save button (sticky bottom)

---

### 5.4 Trades Page

**Current Issues:**
- Split view inefficient for mobile
- Event timeline verbose
- No visual trade outcome indicators

**Redesign Strategy:**

```
┌──────────────────────────────────────────────────┐
│ [All] [Open] [Closed] [Profitable]    Filter ▼  │
├──────────────────────────────────────────────────┤
│ ┌────────────────────────────────────────────┐  │
│ │ BTCUSDT LONG    +$45.20 🟢  May 02 05:36 pm│  │ ← Trade Card
│ │ Entry: 48,234 · TP1: 48,890 ✓ · SL: 47,800 │  │
│ │ [View Details ▼]                            │  │
│ └────────────────────────────────────────────┘  │
│ ┌────────────────────────────────────────────┐  │
│ │ ETHUSDT SHORT   -$12.50 🔴  May 02 03:15 pm│  │
│ │ Entry: 3,245 · SL Hit ✗                    │  │
│ └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

**Improvements:**
- Card-based layout (expand for events)
- P&L prominently displayed with color
- Condensed trade metrics in single line
- Event timeline hidden behind expand

---

### 5.5 Navigation (DashboardShell)

**Current Issues:**
- Sidebar takes 288px (18% of 1600px screen)
- Navigation labels verbose

**Redesign Strategy:**

**Desktop (Collapsed Sidebar):**
```
┌───┐
│ ≡ │ ← Hamburger (collapsed state, 64px)
│ 🏠│ ← Overview
│ 📊│ ← Trades
│ ⚙️│ ← Settings
│ 📈│ ← Analytics
│ 👑│ ← Admin
│ 📋│ ← Logs
└───┘
```

**Mobile (Bottom Tab Bar):**
```
┌─────┬─────┬─────┬─────┬─────┐
│ 🏠  │ 📊  │ ⚙️  │ 📈  │ ⋯  │
└─────┴─────┴─────┴─────┴─────┘
```

**Improvements:**
- Icon-only collapsed state (64px wide)
- Expand on hover/click (280px)
- Bottom navigation for mobile
- "More" menu for secondary items

---

## 6. Human Psychology & UX Patterns

### 6.1 Cognitive Load Reduction

**Chunking Information:**
- Group related data (Gestalt Principles)
- Use whitespace liberally (breathing room)
- Limit choices to 5-7 items per section

**Progressive Disclosure:**
```
Level 1: Critical stats (always visible)
Level 2: Details (click to expand)
Level 3: Historical data (separate page)
```

### 6.2 Visual Attention Patterns

**Von Restorff Effect (Isolation Effect):**
- Make critical alerts visually distinct
- Use color sparingly for emphasis
- Animate only urgent items

**Serial Position Effect:**
- Most important items at top/bottom
- Secondary items in middle
- Sticky headers for context

### 6.3 Micro-interactions

**Feedback Loops:**
```typescript
// Button Press
1. Scale down (95%) on mousedown
2. Color shift on hover
3. Success checkmark on completion
4. Fade out notification after 3s

// Data Update
1. Pulse border on new value
2. Smooth number transition
3. Highlight row briefly
4. Return to normal state
```

**Loading States:**
- Skeleton screens (avoid spinners)
- Optimistic UI updates
- Progress indicators for >2s operations

### 6.4 Error Prevention

**Confirmation Patterns:**
- Destructive actions require double-confirm
- Inline validation (immediate feedback)
- Undo buffers for reversible actions
- Clear error messages with recovery steps

---

## 7. Accessibility & Performance

### 7.1 WCAG 2.1 AA Compliance

**Color Contrast:**
- Text/background: Minimum 4.5:1
- Large text: Minimum 3:1
- Interactive elements: 3:1 against adjacent

**Keyboard Navigation:**
- All actions accessible via Tab
- Focus indicators visible (2px ring)
- Skip links for repetitive content

**Screen Reader Support:**
- Semantic HTML (header, nav, main, aside)
- ARIA labels for icons
- Live regions for dynamic content

### 7.2 Performance Targets

**Core Web Vitals:**
- LCP (Largest Contentful Paint): <2.5s
- FID (First Input Delay): <100ms
- CLS (Cumulative Layout Shift): <0.1

**Optimization Strategies:**
- Lazy load below-fold content
- Virtual scrolling for long lists (>50 items)
- Debounce search inputs (300ms)
- Memoize expensive calculations

---

## 8. Implementation Checklist

### Phase 1: Foundation (Week 1)
- [ ] Create design token file (colors, spacing, typography)
- [ ] Build component library (MetricCard, StatusBadge, etc.)
- [ ] Implement navigation redesign
- [ ] Setup animation utilities

### Phase 2: Core Pages (Week 2)
- [ ] Dashboard overview redesign
- [ ] Logs page table layout
- [ ] Settings accordion structure
- [ ] Trades card-based layout

### Phase 3: Polish (Week 3)
- [ ] Micro-interactions and transitions
- [ ] Loading states and skeletons
- [ ] Error states and empty states
- [ ] Mobile responsive breakpoints

### Phase 4: Validation (Week 4)
- [ ] Accessibility audit (aXe, WAVE)
- [ ] Performance testing (Lighthouse)
- [ ] Cross-browser testing
- [ ] User testing (5 participants)

---

## 9. Claude Opus 4.5 Implementation Prompt

**Copy the prompt below and paste it into a new Claude Opus 4.5 conversation:**

---

### 🎨 COMPREHENSIVE UI/UX REDESIGN PROMPT

You are an expert frontend developer tasked with redesigning the Marine Trader crypto trading bot dashboard UI. Your goal is to create a modern, compact, aesthetic, and highly usable interface following industry best practices.

**CONTEXT:**
- Next.js 14 with App Router
- TypeScript + React
- Tailwind CSS for styling
- Firebase for data (use mock data/placeholders)
- Current pages: Dashboard, Trades, Logs, Settings, Admin, Analytics, Telegram, Login

**DESIGN SYSTEM:**

**Colors:**
```typescript
// tailwind.config.ts - Add to extend.colors
{
  'marine-navy': '#0A2540',
  'marine-blue': '#1E40AF',
  'marine-mist': '#F0F4F8',
  'marine-accent': '#3B82F6',
  'trade-up': '#10B981',
  'trade-down': '#EF4444',
  'trade-neutral': '#6B7280'
}
```

**Typography Scale:**
- Display: `text-4xl font-bold`
- H1: `text-2xl font-semibold`
- H2: `text-lg font-semibold`
- Body: `text-sm`
- Caption: `text-xs`

**Spacing:**
- Micro: `gap-1` (4px)
- Compact: `gap-2` (8px)
- Base: `gap-3` (12px)
- Comfortable: `gap-4` (16px)
- Loose: `gap-6` (24px)

**COMPONENTS TO CREATE:**

**1. MetricCard Component** (`web/src/components/ui/MetricCard.tsx`)
```tsx
interface MetricCardProps {
  label: string;
  value: string | number;
  trend?: 'up' | 'down' | 'neutral';
  trendValue?: string;
  icon?: ReactNode;
  className?: string;
}
```
**Visual Spec:**
- Compact card (120px × 100px)
- Large value text (text-2xl)
- Small label above (text-xs uppercase)
- Optional trend indicator with color
- Subtle border and shadow

**2. StatusBadge Component** (`web/src/components/ui/StatusBadge.tsx`)
```tsx
interface StatusBadgeProps {
  status: 'success' | 'warning' | 'danger' | 'neutral';
  label: string;
  pulse?: boolean;
  size?: 'sm' | 'md';
}
```
**Visual Spec:**
- Pill shape (rounded-full)
- Colored dot + text
- Optional pulse animation for critical
- Small (24px h) or medium (32px h)

**3. CompactTable Component** (`web/src/components/ui/CompactTable.tsx`)
```tsx
interface CompactTableProps {
  headers: string[];
  rows: Array<Record<string, ReactNode>>;
  maxHeight?: string;
  onRowClick?: (row: any) => void;
}
```
**Visual Spec:**
- Sticky header row
- Zebra striping (even rows bg-marine-mist)
- Hover highlight
- Max height with scroll
- 32px row height

**4. ActivityFeed Component** (`web/src/components/ui/ActivityFeed.tsx`)
```tsx
interface ActivityItem {
  id: string;
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  metadata?: Record<string, any>;
}
```
**Visual Spec:**
- Timeline layout (vertical line on left)
- Timestamp on left (text-xs)
- Message on right
- Type badge/dot with color
- Max 10 items, scroll for more

**5. CollapsibleSection Component** (`web/src/components/ui/CollapsibleSection.tsx`)
```tsx
interface CollapsibleSectionProps {
  title: string;
  children: ReactNode;
  defaultExpanded?: boolean;
}
```
**Visual Spec:**
- Accordion-style toggle
- Chevron icon rotates on expand
- Smooth height transition (300ms)
- Border separation

**6. QuickAction Component** (`web/src/components/ui/QuickAction.tsx`)
```tsx
interface QuickActionProps {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
}
```
**Visual Spec:**
- Square button (48px × 48px) with icon
- Label below icon
- Hover scale effect (105%)
- Active state (95%)

**NAVIGATION REDESIGN:**

**7. Sidebar Component** (`web/src/components/navigation/Sidebar.tsx`)
```tsx
interface SidebarProps {
  collapsed?: boolean;
  onToggle?: () => void;
  activeItem: string;
}
```
**Visual Spec (Desktop):**
- Collapsed: 64px wide (icon-only)
- Expanded: 280px wide (icon + label)
- Smooth width transition
- Hover to expand (optional)
- Icon library: lucide-react

**Visual Spec (Mobile):**
- Bottom tab bar (fixed)
- 5 primary items (Home, Trades, Settings, Analytics, More)
- Active indicator (top border or filled icon)

**8. Header Component** (`web/src/components/navigation/Header.tsx`)
```tsx
interface HeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}
```
**Visual Spec:**
- Sticky top (z-50)
- Breadcrumbs for nested pages
- Quick actions on right (notifications, profile)
- 60px height

**PAGE REDESIGNS:**

**9. Dashboard Page** (`web/src/app/page.tsx`)

**Layout Structure:**
```tsx
<DashboardLayout>
  {/* Status Bar - 60px height */}
  <StatusBar
    systemHealth="healthy"
    activePositions={3}
    lastSignal="BTCUSDT"
  />

  {/* Metrics Row - 4 cards */}
  <MetricsRow>
    <MetricCard label="24h Change" value="+2.3%" trend="up" />
    <MetricCard label="Open Positions" value={3} />
    <MetricCard label="P&L Today" value="+$234.50" trend="up" />
    <MetricCard label="Signals" value={12} />
  </MetricsRow>

  {/* Two Column Layout */}
  <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
    {/* Left: Quick Actions */}
    <QuickActionsPanel>
      <QuickAction label="Kill Switch" icon={<AlertTriangle />} variant="danger" />
      <QuickAction label="Paper Mode" icon={<FileText />} />
      <QuickAction label="Refresh Data" icon={<RefreshCw />} />
    </QuickActionsPanel>

    {/* Right: Activity Feed */}
    <ActivityFeed items={recentActivity} />
  </div>
</DashboardLayout>
```

**Visual Requirements:**
- Compact header (no redundant user info)
- Metric cards in single row (responsive)
- Activity feed with timeline design
- Quick actions as prominent buttons

**10. Logs Page** (`web/src/app/logs/page.tsx`)

**Layout Structure:**
```tsx
<DashboardLayout>
  {/* Tabs + Search Bar */}
  <div className="flex items-center justify-between">
    <Tabs>
      <Tab active>Telegram</Tab>
      <Tab>System</Tab>
      <Tab>Errors</Tab>
    </Tabs>
    <SearchInput placeholder="Search logs..." />
  </div>

  {/* Compact Table */}
  <CompactTable
    headers={['Time', 'Source', 'Message', 'Details']}
    rows={logs.map(log => ({
      time: formatTime(log.timestamp),
      source: <StatusBadge status={log.level} label={log.component} />,
      message: log.message,
      details: log.details
    }))}
    maxHeight="calc(100vh - 240px)"
  />
</DashboardLayout>
```

**Visual Requirements:**
- Table format (not cards)
- Color-coded severity dots
- Inline search with debounce
- Virtual scrolling for >100 items

**11. Settings Page** (`web/src/app/settings/page.tsx`)

**Layout Structure:**
```tsx
<DashboardLayout>
  {/* Accordion Sections */}
  <CollapsibleSection title="Trading Controls" defaultExpanded>
    <div className="grid gap-4 md:grid-cols-2">
      <FormField label="Risk Mode" type="select" options={['Fixed USDT', 'Percent']} />
      <FormField label="Risk Value" type="number" value={20} />
      <FormField label="Max Open" type="number" value={3} />
      <FormField label="Max Per Symbol" type="number" value={1} />
    </div>
  </CollapsibleSection>

  <CollapsibleSection title="Telegram Settings">
    <ChatIDManager chatIds={chatIds} />
  </CollapsibleSection>

  <CollapsibleSection title="Safety Toggles">
    <div className="flex gap-4">
      <Toggle label="Paper Mode" checked={paperMode} />
      <Toggle label="Kill Switch" checked={killSwitch} />
    </div>
  </CollapsibleSection>

  {/* Sticky Bottom Actions */}
  <div className="sticky bottom-0 flex justify-end gap-3 bg-white p-4">
    <Button variant="secondary">Cancel</Button>
    <Button variant="primary">Save Changes</Button>
  </div>
</DashboardLayout>
```

**Visual Requirements:**
- Collapsible sections (only 1 expanded at a time)
- Inline form labels (reduce vertical space)
- Toggle switches for booleans
- Sticky save button

**12. Trades Page** (`web/src/app/trades/page.tsx`)

**Layout Structure:**
```tsx
<DashboardLayout>
  {/* Filter Bar */}
  <FilterBar>
    <FilterChip active>All</FilterChip>
    <FilterChip>Open</FilterChip>
    <FilterChip>Closed</FilterChip>
    <FilterChip>Profitable</FilterChip>
  </FilterBar>

  {/* Trade Cards */}
  <div className="space-y-3">
    {trades.map(trade => (
      <TradeCard
        key={trade.id}
        symbol={trade.symbol}
        direction={trade.direction}
        pnl={trade.pnl}
        entry={trade.entry}
        tp={trade.tp}
        sl={trade.sl}
        events={trade.events}
        expandable
      />
    ))}
  </div>
</DashboardLayout>
```

**Visual Requirements:**
- Card-based layout (expand for details)
- P&L prominently displayed with color
- Condensed metrics in single line
- Event timeline hidden behind expand

**13. Login Page** (`web/src/app/login/page.tsx`)

**Layout Structure:**
```tsx
<div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-marine-navy to-marine-blue">
  <Card className="w-full max-w-md">
    <div className="flex items-center gap-3">
      <Logo size={48} />
      <div>
        <h1 className="text-2xl font-bold">Marine Trader</h1>
        <p className="text-xs text-marine-navy/60">Command Center</p>
      </div>
    </div>
    
    <p className="mt-4 text-sm">Sign in to access your trading dashboard</p>
    
    <Button
      variant="primary"
      size="lg"
      icon={<GoogleIcon />}
      onClick={handleGoogleLogin}
      className="mt-6 w-full"
    >
      Continue with Google
    </Button>
    
    {error && <ErrorMessage>{error}</ErrorMessage>}
  </Card>
</div>
```

**Visual Requirements:**
- Centered card on gradient background
- Large Google button
- Minimal branding
- Error states with clear messaging

**ANIMATION & MICRO-INTERACTIONS:**

**Required Animations:**
1. **Page Transitions:** Fade in (300ms ease-out)
2. **Hover States:** Scale 105% (150ms ease-out)
3. **Active States:** Scale 95% (100ms ease-in)
4. **Loading:** Skeleton screens (pulse animation)
5. **Success Feedback:** Checkmark with fade out (2s)
6. **Error Shake:** Horizontal shake (500ms)

**Implementation Example:**
```tsx
// Hover animation
className="transition-transform duration-150 hover:scale-105"

// Pulse animation for critical alerts
className="animate-pulse"

// Slide up on mount
className="animate-in slide-in-from-bottom-4 duration-300"
```

**RESPONSIVE BREAKPOINTS:**

```typescript
// Mobile: < 768px
- Single column layouts
- Bottom tab navigation
- Stacked metric cards

// Tablet: 768px - 1024px
- 2-column grids
- Collapsed sidebar by default
- Reduced padding

// Desktop: > 1024px
- Multi-column layouts
- Expanded sidebar
- Full feature set
```

**DELIVERABLES:**

Create the following files with complete, production-ready code:

**Components:**
1. `web/src/components/ui/MetricCard.tsx`
2. `web/src/components/ui/StatusBadge.tsx`
3. `web/src/components/ui/CompactTable.tsx`
4. `web/src/components/ui/ActivityFeed.tsx`
5. `web/src/components/ui/CollapsibleSection.tsx`
6. `web/src/components/ui/QuickAction.tsx`
7. `web/src/components/ui/FormField.tsx`
8. `web/src/components/ui/Button.tsx`
9. `web/src/components/navigation/Sidebar.tsx`
10. `web/src/components/navigation/Header.tsx`

**Pages:**
11. `web/src/app/page.tsx` (Dashboard)
12. `web/src/app/logs/page.tsx`
13. `web/src/app/settings/page.tsx`
14. `web/src/app/trades/page.tsx`
15. `web/src/app/login/page.tsx`

**Utilities:**
16. `web/src/lib/animations.ts` (Animation utilities)
17. `web/src/lib/mockData.ts` (Mock data for UI demonstration)

**CRITICAL REQUIREMENTS:**

1. **Use ONLY Tailwind CSS** - No external UI libraries (shadcn, MUI, etc.)
2. **Mock all data sources** - Use placeholder data, no Firebase calls
3. **TypeScript strict mode** - Proper typing for all props
4. **Accessibility first** - ARIA labels, keyboard navigation, focus indicators
5. **Mobile responsive** - Test all breakpoints
6. **Performance optimized** - Memoize components, lazy load where needed
7. **Consistent spacing** - Follow the spacing system exactly
8. **Icon library** - Use `lucide-react` for all icons

**EXAMPLE IMPLEMENTATION PATTERN:**

```tsx
// MetricCard.tsx
import { type ReactNode } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

interface MetricCardProps {
  label: string;
  value: string | number;
  trend?: 'up' | 'down' | 'neutral';
  trendValue?: string;
  icon?: ReactNode;
  className?: string;
}

export function MetricCard({ label, value, trend, trendValue, icon, className = '' }: MetricCardProps) {
  const trendIcon = trend === 'up' ? TrendingUp : trend === 'down' ? TrendingDown : Minus;
  const trendColor = trend === 'up' ? 'text-trade-up' : trend === 'down' ? 'text-trade-down' : 'text-trade-neutral';
  
  return (
    <div className={`rounded-xl border border-marine-navy/10 bg-white p-4 shadow-sm ${className}`}>
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wider text-marine-navy/60">{label}</p>
        {icon && <div className="text-marine-navy/40">{icon}</div>}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <p className="text-2xl font-bold text-marine-navy">{value}</p>
        {trend && trendValue && (
          <div className={`flex items-center gap-1 text-xs font-medium ${trendColor}`}>
            {trendIcon && <TrendingIcon className="h-3 w-3" />}
            <span>{trendValue}</span>
          </div>
        )}
      </div>
    </div>
  );
}
```

**WORKFLOW:**

1. Start by creating all UI components in the `web/src/components/ui/` directory
2. Create navigation components in `web/src/components/navigation/`
3. Update each page to use the new components with mock data
4. Add animations and micro-interactions
5. Test responsive behavior at all breakpoints
6. Ensure accessibility compliance
7. Optimize performance (memoization, lazy loading)

**OUTPUT FORMAT:**

For each file, provide:
1. Full file path
2. Complete code (no placeholders or "// existing code" comments)
3. Brief description of the component's purpose
4. Usage example if complex

**CONSTRAINTS:**

- Complete implementation in single response
- No external dependencies beyond: lucide-react, tailwind
- All components must be client components ('use client')
- Focus on UI/UX only - use placeholder functions for logic (e.g., `onClick={() => console.log('Clicked')}`)

**BEGIN IMPLEMENTATION NOW.**

Generate all components and pages following the specifications above. Prioritize visual hierarchy, information density, and user satisfaction. Make it beautiful, fast, and intuitive.

---

**END OF IMPLEMENTATION PROMPT**

---

## Conclusion

This comprehensive guide provides:
1. ✅ Industry-standard design principles
2. ✅ Detailed component specifications
3. ✅ Page-by-page redesign strategies
4. ✅ Psychology-based UX patterns
5. ✅ Accessibility and performance targets
6. ✅ Complete implementation prompt for Claude Opus 4.5

**Expected Outcome:** A modern, compact, highly usable trading dashboard that reduces cognitive load, increases information density, and provides a professional user experience on par with industry leaders like Bloomberg Terminal and TradingView.

**Implementation Time:** Single Claude Opus 4.5 session (estimated 15-20 minutes for full generation)

**Next Steps:**
1. Copy the implementation prompt (Section 9)
2. Paste into Claude Opus 4.5
3. Review generated components
4. Integrate with existing logic
5. Test and iterate

---

*Document Version: 1.0*  
*Last Updated: February 1, 2026*  
*Author: Marine Trader Team*
