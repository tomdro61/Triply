/**
 * Test-run environment.
 *
 * Several modules construct their SDK client at import time (`new Stripe(...)`
 * in src/lib/stripe/client.ts, for example), and the booking tests deliberately
 * `importActual` some of those to exercise real pure logic rather than a mock of
 * it. So the environment has to exist before any import runs.
 *
 * Every value here is an obvious dummy. Nothing in the suite makes a network
 * call — a real key must never be needed to run the tests, or the suite stops
 * being runnable in CI and in a pre-commit hook.
 */

process.env.STRIPE_SECRET_KEY ||= "sk_test_dummy_for_unit_tests";
process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ||= "pk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET ||= "whsec_dummy";

process.env.RESLAB_API_KEY ||= "dummy";
process.env.RESLAB_API_DOMAIN ||= "test.invalid";
process.env.RESLAB_API_URL ||= "https://reslab.invalid/v1";

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://supabase.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "dummy";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "dummy";

process.env.RESEND_API_KEY ||= "re_dummy";
process.env.NEXT_PUBLIC_APP_URL ||= "https://www.triplypro.com";

process.env.PARKGUARD_API_URL ||= "https://parkguard.invalid";
process.env.PARKGUARD_API_KEY ||= "dummy";
