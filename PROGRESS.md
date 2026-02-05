# Triply Development Progress

> **Last Updated:** February 4, 2026 (auto-integration test)
> **Current Phase:** Phase 4 - Polish & Launch (In Progress)
> **Next Task:** Create CMS admin user, add sample blog content, continue Phase 4 tasks
>
> **🎉 MILESTONE: Full booking flow working end-to-end with ResLab!**

---

## Project Overview

- **Project:** Triply - Airport Parking Aggregator
- **Domain:** triplypro.com
- **Launch Markets:** New York (JFK, LGA)
- **Inventory Source:** Reservations Lab API (MVP)
- **GitHub:** https://github.com/tomdro61/Triply

---

## Development Phases

### Phase 1: Foundation ✅ COMPLETE

| Task | Status | Notes |
|------|--------|-------|
| Initialize Next.js 16 project | ✅ Done | App Router, TypeScript, Tailwind |
| Install shadcn/ui components | ✅ Done | 17+ components installed |
| Set up project structure | ✅ Done | components/, lib/, hooks/, types/, config/ |
| Configure design system | ✅ Done | Brand colors, Poppins/Inter fonts |
| Create environment config | ✅ Done | .env.example with all placeholders |
| Set up PWA foundation | ✅ Done | manifest.json, offline page |
| Configure Sentry | ✅ Done | Client, server, edge configs |
| Create airport config | ✅ Done | JFK and LGA |
| Initialize Git + GitHub | ✅ Done | tomdro61/Triply |
| Match design mockup | ✅ Done | All homepage components |

**Homepage Components Created:**
- [x] Navbar (transparent → solid on scroll)
- [x] Hero (full-bleed background, search widget)
- [x] StatsBar (trust signals)
- [x] FeatureCards (4 cards with hover effects)
- [x] HowItWorks (4-step process)
- [x] FAQ (accordion)
- [x] Newsletter (email signup)
- [x] Footer (dark navy)

---

### Phase 2: Core Booking Flow ✅ COMPLETE

| Task | Status | Notes |
|------|--------|-------|
| Search Results Page | ✅ Done | Split view: list + map, real ResLab data |
| Lot Detail Page | ✅ Done | Image gallery, booking widget, real pricing |
| Checkout Page | ✅ Done | Multi-step form, real lot/pricing data |
| Confirmation Page | ✅ Done | QR code, booking details from ResLab |
| API Routes | ✅ Done | /api/search, /api/checkout/lot, /api/reservations |
| Reservations Lab Integration | ✅ Done | Full booking flow working end-to-end |
| Stripe Integration | ✅ Done | Test keys configured, PaymentElement working |
| Email Confirmation | ✅ Done | Resend integrated, confirmation email template |
| **Supabase Setup** | ✅ Done | Database + Auth project created |
| **User Auth (Email + Google)** | ✅ Done | Login/signup UI, Google OAuth working |
| **Database Schema** | ✅ Done | customers + bookings tables |
| **Store Guest Bookings** | ✅ Done | All bookings saved to Supabase |
| **Optional Account Creation** | ✅ Done | Prompt on confirmation page for guests |

**✅ Full Booking Flow Tested & Working:**
- Search → Checkout → Payment (dev bypass) → ResLab Reservation → Confirmation
- Reservations appear in ResLab dashboard
- Confirmation page shows real booking data from ResLab API

**✅ Supabase / User Accounts (Implemented):**
- Auth methods: Email/password + Google OAuth
- Guest checkout remains available (no account required)
- All bookings stored in Supabase (guest + logged in)
- Logged-in users: bookings linked to account via `user_id`
- Checkout form pre-fills with user's name/email when logged in
- Apple Sign-In out of scope for MVP

**✅ Phase 2 Complete!**
All core booking flow features are implemented.

**Search Results Page Requirements:**
- [x] Split view layout (40% list / 60% map)
- [x] Sticky search bar with location, dates, times
- [x] Tabs: Parking / Park + Hotel
- [x] Result cards with image, title, distance, amenities, rating, price
- [x] Sort dropdown (Recommended, Price, Rating, Distance)
- [x] Map with price pins (highlight on hover)
- [x] Slide-out product detail panel
- [x] Connect to /api/search route (mock data)
- [x] Loading states and error handling

**Lot Detail Page Requirements:**
- [x] Back button / breadcrumb
- [x] Image gallery (1 large + 4 thumbnails) with lightbox
- [x] Title, location, rating
- [x] Overview section with icons
- [x] "What's Included" amenities list
- [x] Location map (mock)
- [x] Sticky booking widget (right side)
- [x] Date pickers, price breakdown with taxes
- [x] "Reserve Now" button → checkout
- [x] Share and Save buttons
- [x] SEO metadata generation

**Checkout Page Requirements:**
- [x] Multi-step form (Details → Vehicle → Payment)
- [x] Customer info (name, email, phone)
- [x] Vehicle info (make, model, color, license plate, state)
- [x] Stripe Elements integration (mock UI)
- [x] Apple Pay / Google Pay tabs (mock)
- [x] Promo code input with validation
- [x] Order summary sidebar with price breakdown
- [x] Terms acceptance checkbox
- [x] Form validation with error messages
- [x] Step progress indicator

**Confirmation Page Requirements:**
- [x] Confirmation number display
- [x] Booking details summary (lot, dates, duration, total, customer/vehicle info)
- [x] QR code for check-in (with download and copy)
- [x] Add to Calendar buttons (Google, Outlook, Apple, ICS download)
- [x] Get Directions link (opens Google Maps)
- [x] "What's Next" instructions (step-by-step guide)
- [x] Email sent confirmation indicator
- [x] Add to Wallet button (placeholder)
- [x] Return Home / Book Another buttons

---

### Phase 3: Content & Admin ✅ COMPLETE

| Task | Status | Notes |
|------|--------|-------|
| **My Reservations Page** | ✅ Done | User's upcoming/past bookings |
| **Account Settings Page** | ✅ Done | Profile, password, preferences |
| **Help/FAQ Page** | ✅ Done | Support content, searchable FAQs |
| **Legal Pages** | ✅ Done | Terms of Service, Privacy Policy |
| **Contact Us Page** | ✅ Done | Contact form with Resend email |
| **Admin Dashboard** | ✅ Done | Stats, bookings list, detail view |
| **Payload CMS Setup** | ✅ Done | Separate subdomain deployment (triply-cms/) |
| **Blog Implementation** | ✅ Done | /blog, /blog/[slug] fetching from CMS subdomain |
| Email Templates | ✅ Done | Booking confirmation (completed in Phase 2) |

---

### Phase 4: Polish & Launch 🔄 IN PROGRESS

| Task | Status | Notes |
|------|--------|-------|
| **Staging Deployment - CMS** | ✅ Done | triply-cms.vercel.app |
| **Staging Deployment - Main App** | ✅ Done | Deployed to Vercel |
| SEO Implementation | 🔲 Todo | Meta tags, sitemap |
| Performance Optimization | 🔲 Todo | Images, caching |
| Testing | 🔲 Todo | E2E booking flow |
| Production Setup | 🔲 Todo | Custom domains, SSL |
| Launch Checklist | 🔲 Todo | Final verification |

**Staging URLs:**
- **CMS:** https://triply-cms.vercel.app/admin
- **Main App:** Deployed to Vercel (URL from dashboard)

**Environment Variables Configured:**
- NEXT_PUBLIC_CMS_URL (pointing to CMS Vercel URL)
- Supabase keys (URL, anon key, service role key)
- ResLab API key (test)
- Stripe keys (test mode)
- Resend API key
- NEXT_PUBLIC_APP_URL, RESLAB_API_DOMAIN

---

## Technical Stack

| Layer | Technology | Status |
|-------|------------|--------|
| Framework | Next.js 16 (App Router) | ✅ Configured |
| Styling | Tailwind CSS + shadcn/ui | ✅ Configured |
| Database | Supabase PostgreSQL | ✅ Configured |
| Auth | Supabase Auth (Email + Google) | ✅ Configured |
| Payments | Stripe | ✅ Configured |
| Maps | Mapbox | 🔲 Need account |
| CMS | Payload CMS 3.0 | ✅ Configured (separate subdomain: triply-cms/) |
| Email | Resend | ✅ Configured |
| Hosting | Vercel | ✅ Staging deployed (CMS + Main App) |
| Error Tracking | Sentry | 🔲 Need account |
| Analytics | Google Analytics 4 | 🔲 Need account |

---

## Service Accounts Needed

| Service | Phase | Status | Action Required |
|---------|-------|--------|-----------------|
| Reservations Lab | 2 | ✅ Configured | Test API key working (triplypro.com) |
| Supabase | 2 | ✅ Configured | Triply-prod project, DB schema deployed |
| Stripe | 2 | ✅ Configured | Test keys working (pk_test_51Svg...) |
| Resend | 2 | ✅ Configured | API key working, confirmation template ready |
| Mapbox | 2 | ❌ Not created | Create account at mapbox.com (maps) |
| Payload CMS | 3 | ✅ Configured | Self-hosted, uses existing Supabase PostgreSQL |
| Sentry | 4 | ❌ Not created | Create project at sentry.io (error tracking) |
| Google Analytics | 4 | ❌ Not created | Create GA4 property (analytics) |

---

## Design Reference

The design mockup is located at:
```
C:\Users\tomjd\OneDrive\Desktop\Triply_claude\Triply_design_mock\
```

Key components to reference:
- `SearchResults.tsx` - Split view with map
- `ProductPage.tsx` - Lot detail page
- `ProductDetailSlider.tsx` - Slide-out panel

---

## File Structure

```
triply/
├── src/
│   ├── app/
│   │   ├── page.tsx                 # Homepage ✅
│   │   ├── layout.tsx               # Root layout ✅
│   │   ├── globals.css              # Styles ✅
│   │   ├── offline/page.tsx         # PWA offline ✅
│   │   ├── search/page.tsx          # Search results ✅
│   │   ├── auth/
│   │   │   ├── login/page.tsx       # Login/signup page ✅
│   │   │   └── callback/route.ts    # OAuth callback ✅
│   │   ├── [slug]/
│   │   │   └── airport-parking/
│   │   │       └── [lot]/page.tsx   # Lot detail ✅
│   │   ├── checkout/page.tsx        # Checkout ✅
│   │   ├── confirmation/[id]/page.tsx # Confirmation ✅
│   │   ├── reservations/page.tsx    # My Reservations ✅
│   │   ├── account/page.tsx         # Account Settings ✅
│   │   ├── help/page.tsx            # Help/FAQ Page ✅
│   │   ├── terms/page.tsx           # Terms of Service ✅
│   │   ├── privacy/page.tsx         # Privacy Policy ✅
│   │   ├── contact/page.tsx         # Contact Us Page ✅
│   │   ├── admin/
│   │   │   ├── layout.tsx           # Admin layout + auth ✅
│   │   │   ├── page.tsx             # Admin dashboard ✅
│   │   │   └── bookings/page.tsx    # Bookings list ✅
│   │   ├── blog/
│   │   │   ├── page.tsx             # Blog listing ✅
│   │   │   └── [slug]/page.tsx      # Single post ✅
│   │   ├── (main)/
│   │   │   └── blog/                # Blog pages (fetches from CMS subdomain) ✅
│   │   └── api/
│   │       ├── search/route.ts      # Search API ✅ (ResLab)
│   │       ├── checkout/lot/route.ts # Lot details for checkout ✅
│   │       ├── reservations/route.ts # Create/get reservations ✅
│   │       ├── payment-intent/route.ts # Stripe PaymentIntent ✅
│   │       ├── contact/route.ts      # Contact form API ✅
│   │       ├── user/
│   │       │   ├── bookings/route.ts # User's bookings API ✅
│   │       │   └── profile/route.ts  # User profile API ✅
│   │       └── admin/
│   │           ├── stats/route.ts    # Admin stats API ✅
│   │           └── bookings/route.ts # Admin bookings API ✅
│   ├── components/
│   │   ├── shared/                  # Layout components ✅
│   │   ├── search/                  # Search components ✅
│   │   ├── lot/                     # Lot detail components ✅
│   │   ├── checkout/                # Checkout components ✅
│   │   │   ├── stripe-provider.tsx  # Stripe Elements wrapper ✅
│   │   │   └── stripe-payment-form.tsx # PaymentElement form ✅
│   │   ├── confirmation/            # Confirmation components ✅
│   │   ├── reservations/            # My Reservations components ✅
│   │   │   └── reservation-card.tsx # Reservation card component ✅
│   │   ├── blog/                    # Blog components ✅
│   │   │   └── RichText.tsx         # Lexical content renderer ✅
│   │   └── ui/                      # shadcn/ui ✅
│   │   # Note: Payload CMS is in separate triply-cms/ directory
│   ├── lib/
│   │   ├── reslab/client.ts         # ResLab API ✅ (fully integrated)
│   │   ├── reslab/get-lot.ts        # Lot fetching helpers ✅
│   │   ├── supabase/client.ts       # Supabase browser client ✅
│   │   ├── supabase/server.ts       # Supabase server client ✅
│   │   ├── stripe/client.ts         # Stripe server client ✅
│   │   ├── resend/client.ts         # Resend email client ✅
│   │   ├── resend/send-booking-confirmation.ts # Email sender ✅
│   │   ├── resend/templates/        # Email templates ✅
│   │   └── utils.ts                 # Utilities ✅
│   ├── config/
│   │   ├── airports.ts              # JFK, LGA ✅
│   │   ├── site.ts                  # Site config ✅
│   │   └── design.ts                # Design tokens ✅
│   └── types/
│       ├── booking.ts               # Booking types ✅
│       ├── checkout.ts              # Checkout types ✅
│       └── lot.ts                   # Lot types ✅
├── supabase/
│   └── migrations/                  # Database migrations ✅
├── public/
│   ├── manifest.json                # PWA ✅
│   ├── Coral-logo.png               # Logo ✅
│   └── coral-logo-white.png         # White logo ✅
├── .env.example                     # Env template ✅
├── .env.local                       # Local env (not committed) ✅
├── PROGRESS.md                      # This file ✅
└── CLAUDE.md                        # Project instructions ✅
```

---

## Admin Emails

- vin@triplypro.com
- john@triplypro.com
- tom@triplypro.com

---

## Quick Commands

```bash
# Development
cd C:\Users\tomjd\OneDrive\Desktop\Triply_claude\triply
npm run dev

# Build
npm run build

# Start production
npm run start
```

---

## Supabase Database Schema (Planned)

```sql
-- Users table (managed by Supabase Auth)
-- Includes: id, email, created_at, etc.

-- Customers table (links to users, stores guest info)
customers:
  - id (uuid, primary key)
  - user_id (uuid, nullable, foreign key to auth.users)
  - email (text, required)
  - first_name (text)
  - last_name (text)
  - phone (text)
  - created_at (timestamp)

-- Bookings table (all reservations)
bookings:
  - id (uuid, primary key)
  - customer_id (uuid, foreign key to customers)
  - reslab_reservation_number (text, unique)
  - reslab_location_id (int)
  - location_name (text)
  - check_in (timestamp)
  - check_out (timestamp)
  - grand_total (decimal)
  - status (text: confirmed, cancelled, completed)
  - vehicle_info (jsonb)
  - created_at (timestamp)
```

---

## Notes for Next Session

1. **Read this file first** to understand current progress
2. **🎉 PHASE 3 COMPLETE** - All content pages, admin dashboard, and CMS done!
3. **🎉 STAGING DEPLOYED** - Both CMS and main app deployed to Vercel!
4. **Payload CMS** - Separate project deployed to triply-cms.vercel.app
5. **Blog** - Frontend at `/blog` and `/blog/[slug]`, fetches from CMS subdomain
6. **Make/N8N Integration** - Payload supports API key auth for automation
7. **Next priority:** Create CMS admin user, add blog content, continue Phase 4 tasks
8. **Test airports:** TEST-NY (location 195) and TEST-OH (location 194)
9. **Custom domains:** Set up cms.triplypro.com and staging.triplypro.com when DNS ready

**Dev Mode (Stripe Bypass):**
- Set `NEXT_PUBLIC_DEV_SKIP_PAYMENT=true` to bypass Stripe payment
- Currently set to `false` (Stripe payments enabled)

**For Production:**
- Verify triplypro.com domain in Resend for branded emails
- Swap Stripe test keys for live keys
- Configure Google OAuth redirect URIs for production domain

**Phase 2 Completed Pages:**
- Search Results - split view, map, result cards, sorting, slide-out panel (real ResLab data)
- Lot Detail - image gallery, booking widget, full details, SEO metadata (real ResLab data)
- Checkout - multi-step form, vehicle details, order summary (real pricing from ResLab)
- Confirmation - QR code, booking details fetched from ResLab API

**ResLab Integration Details:**
- Full API client with JWT authentication (auto-refresh)
- Endpoints: searchLocations, getLocation, getMinPrice, getCost, createReservation, getReservation
- Test locations: 194 (TEST-OH) and 195 (TEST-NY)
- Reservations successfully created and viewable in ResLab dashboard
- Confirmation page fetches real reservation data from ResLab

**Dev Mode (Stripe Bypass):**
```bash
# In .env.local - set to bypass Stripe payment:
NEXT_PUBLIC_DEV_SKIP_PAYMENT=true

# Set to false (or remove) to require real Stripe payment:
NEXT_PUBLIC_DEV_SKIP_PAYMENT=false
```
- Shows purple "DEV MODE" banner on payment step
- Skips Stripe, creates reservation directly in ResLab
- Useful for testing full flow without Stripe account

**Search Components Created:**
- `src/components/search/search-header.tsx` - Sticky header with tabs and inputs
- `src/components/search/search-results-list.tsx` - Scrollable results list
- `src/components/search/lot-card.tsx` - Individual lot card component
- `src/components/search/mock-map.tsx` - Mock map with price pins
- `src/components/search/product-detail-slider.tsx` - Slide-out detail panel
- `src/app/api/search/route.ts` - Search API connected to ResLab (real data)

**Lot Detail Components Created:**
- `src/components/lot/lot-header.tsx` - Back button, title, rating
- `src/components/lot/lot-gallery.tsx` - Image grid with lightbox
- `src/components/lot/lot-overview.tsx` - Description and feature icons
- `src/components/lot/lot-amenities.tsx` - Amenities checklist
- `src/components/lot/lot-location.tsx` - Map placeholder and address
- `src/components/lot/booking-widget.tsx` - Sticky sidebar with real pricing
- `src/lib/reslab/get-lot.ts` - Lot fetching from ResLab API

**Checkout Components Created:**
- `src/components/checkout/checkout-form.tsx` - Main form orchestrator
- `src/components/checkout/checkout-steps.tsx` - Step progress indicator
- `src/components/checkout/customer-details-step.tsx` - Name, email, phone form
- `src/components/checkout/vehicle-details-step.tsx` - Vehicle info form
- `src/components/checkout/payment-step.tsx` - Mock Stripe card form
- `src/components/checkout/order-summary.tsx` - Sidebar with price breakdown
- `src/components/checkout/promo-code.tsx` - Promo code input
- `src/types/checkout.ts` - Checkout-related TypeScript types

**Demo Promo Codes:** SAVE10, SAVE20, TRIPLY

**Stripe Integration (Phase 2):**
- PaymentIntent API: `/api/payment-intent`
- StripeProvider wraps payment form with Elements context
- StripePaymentForm uses PaymentElement (card, Apple Pay, Google Pay)
- Test card: `4242 4242 4242 4242`, any future expiry, any CVC
- Payment confirmed before ResLab reservation created

**Resend Email Integration (Phase 2):**
- Booking confirmation email sent after successful reservation
- React email template with Triply branding
- Uses `@react-email/render` to convert React to HTML
- Currently sends from `onboarding@resend.dev` (test mode)
- Verify triplypro.com domain for production emails

**Confirmation Components Created:**
- `src/components/confirmation/confirmation-header.tsx` - Success message, confirmation ID
- `src/components/confirmation/booking-details.tsx` - Lot info, dates, pricing, customer info
- `src/components/confirmation/qr-code-section.tsx` - QR code with download/copy
- `src/components/confirmation/add-to-calendar.tsx` - Google, Outlook, Apple, ICS export
- `src/components/confirmation/whats-next.tsx` - Step-by-step check-in instructions
- `src/components/confirmation/create-account-prompt.tsx` - Guest account creation (Google or email)

**Confirmation Page Features:**
- Fetches reservation data from ResLab API for real bookings
- Falls back to sessionStorage for lot data (supports ResLab lots not in mock data)
- Shows account creation prompt for guest users (dismissible)
- Checks Supabase auth state to hide prompt for logged-in users

**My Reservations Page (Phase 3):**
- URL: `/reservations`
- Requires authentication (redirects to login if not signed in)
- Displays user's bookings from Supabase (linked via customer.user_id)
- Tabs for "Upcoming" and "Past" reservations
- Each card shows: location, dates/times, vehicle info, status badge, price
- Status badges: Upcoming (blue), Active (green), Completed (gray), Cancelled (red)
- Click card to view full confirmation details
- Empty state with "Find Parking" CTA
- Navbar includes "My Reservations" link in user dropdown

**My Reservations Components:**
- `src/app/reservations/page.tsx` - Main page with auth check, tabs, booking list
- `src/components/reservations/reservation-card.tsx` - Booking card with status, details
- `src/app/api/user/bookings/route.ts` - API to fetch user's bookings from Supabase

**Account Settings Page (Phase 3):**
- URL: `/account`
- Requires authentication (redirects to login if not signed in)
- Profile section: edit first name, last name, phone number
- Shows avatar and email (read-only)
- Password change section (only for email/password users, hidden for OAuth)
- Security section: shows sign-in method, member since date
- Quick links to My Reservations, Help, Book Parking
- Updates both Supabase auth metadata and customers table

**Account Settings Components:**
- `src/app/account/page.tsx` - Main account settings page
- `src/app/api/user/profile/route.ts` - GET and PUT endpoints for user profile

**Admin Dashboard (Phase 3):**
- URL: `/admin` (protected - email whitelist only)
- Admin emails: vin@triplypro.com, john@triplypro.com, tom@triplypro.com
- Dashboard: Stats cards (total bookings, revenue, today/week/month)
- Bookings page: Full list with search, status filter, pagination
- Date range filtering: Today, This Week, This Month, Custom date picker
- Booking detail modal: Customer info, reservation details, vehicle info
- Export CSV functionality for bookings
- Non-admin users see "Access Denied" page

**Admin Dashboard Components:**
- `src/app/admin/layout.tsx` - Admin layout with sidebar, auth check
- `src/app/admin/page.tsx` - Dashboard with stats and recent bookings
- `src/app/admin/bookings/page.tsx` - Full bookings list with filters
- `src/app/api/admin/stats/route.ts` - Stats API (bookings, revenue)
- `src/app/api/admin/bookings/route.ts` - Bookings list API with pagination

**Payload CMS (Phase 3) - Separate Subdomain Deployment:**

> **Architecture Change:** Payload CMS was moved to a separate project (`triply-cms/`) deployed to its own subdomain (`cms.triplypro.com`) due to CSS conflicts between Tailwind CSS v4's Preflight and Payload's admin panel styles. The main `triply/` app no longer contains any Payload code.

- **Why Separate Subdomain:** Clean deployment separation - independent git repos, separate Vercel projects, isolated dependencies, no build-time coupling. Each project can be deployed and versioned independently.
- **CMS Project:** `triply-cms/` (sibling to `triply/`)
- **Admin URL:** `http://localhost:3001/admin` (dev) / `https://cms.triplypro.com/admin` (prod)
- **API URL:** `http://localhost:3001/api` (dev) / `https://cms.triplypro.com/api` (prod)
- **Database:** Uses existing Supabase PostgreSQL with `payload` schema
- **Features:** Blog posts with SEO fields, categories, tags, media uploads, user roles

**CMS Project Structure (triply-cms/):**
```
triply-cms/
├── src/
│   ├── app/
│   │   ├── (frontend)/           # Optional frontend (not used)
│   │   └── (payload)/
│   │       ├── admin/[[...segments]]/page.tsx
│   │       ├── api/[...slug]/route.ts
│   │       └── layout.tsx        # Payload layout with CSS import
│   ├── collections/
│   │   ├── Posts.ts
│   │   ├── Categories.ts
│   │   ├── Tags.ts
│   │   ├── Media.ts
│   │   └── Users.ts
│   └── payload.config.ts
├── next.config.mjs
├── package.json
└── .env.local
```

**Main App Blog Integration:**
- Blog pages in `triply/src/app/(main)/blog/` fetch from CMS subdomain
- Uses `NEXT_PUBLIC_CMS_URL` environment variable
- Example: `fetch(\`${process.env.NEXT_PUBLIC_CMS_URL}/api/posts\`)`

**Running Both Projects (Development):**
```bash
# Terminal 1 - Main app (port 3000)
cd triply && npm run dev

# Terminal 2 - CMS (port 3001)
cd triply-cms && npm run dev -- -p 3001
```

**Environment Variables:**

Main app (`triply/.env.local`):
```bash
NEXT_PUBLIC_CMS_URL=http://localhost:3001
# Production: NEXT_PUBLIC_CMS_URL=https://cms.triplypro.com
```

CMS (`triply-cms/.env.local`):
```bash
PAYLOAD_SECRET=your-secret-key-at-least-32-characters
DATABASE_URI=postgresql://postgres.[ref]:[pass]@aws-1-us-east-2.pooler.supabase.com:5432/postgres
```

**Make/N8N API Integration:**
- Create a CMS user at `http://localhost:3001/admin`
- Generate API key in user settings
- Use header: `Authorization: users API-Key YOUR_KEY_HERE`
- Endpoints: POST `/api/posts`, GET `/api/posts`, POST `/api/media`

---

## Documentation Update Checklist

**This file (`PROGRESS.md`) is the source of truth.** Update it every session.

### When to Update Each File

| Trigger | Update |
|---------|--------|
| Task completed | ✅ Mark task done in PROGRESS.md |
| Major decision made | ✅ Add to PROGRESS.md notes + update affected reference docs |
| Phase completed | ✅ Update phase status, review all docs for accuracy |
| Tech stack change | ✅ Update CLAUDE.md tech stack table |
| Scope change (in/out) | ✅ Update PROGRESS.md + triply_mvp_plan.md |

### Reference Documentation (Update Only When Relevant)

| File | Update When... |
|------|----------------|
| `CLAUDE.md` | Project structure, tech stack, or phase status changes |
| `triply_mvp_plan.md` | Phase scope or priorities change |
| `triply_solution_design.md` | Building that specific feature (use as reference) |
| `triply_architecture_overview.md` | Major architectural decisions |
| `triply_reslab_integration.md` | ResLab API usage changes |

### End of Session Checklist

- [ ] Update "Last Updated" date at top of this file
- [ ] Update "Current Phase" and "Next Task" if changed
- [ ] Mark completed tasks with ✅
- [ ] Add any new decisions to "Notes for Next Session"
- [ ] Commit PROGRESS.md with descriptive message

---

*This file is updated as development progresses. Always check the "Last Updated" date and "Current Phase" at the top.*
