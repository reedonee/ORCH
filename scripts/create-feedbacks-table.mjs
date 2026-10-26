// NOTE: this script is superseded by supabase/migrations/003_feedbacks_rls.sql.
// It originally created `feedbacks` with no RLS, which — combined with the
// blanket anon GRANT in 002_grants.sql — left every user's bug reports
// world-readable and world-deletable. Apply the migrations instead of
// running this. Kept only for reference.
//
// The service-role key must never be committed: it bypasses RLS entirely.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.');
  console.error('Prefer applying supabase/migrations/*.sql instead of this script.');
  process.exit(1);
}

async function main() {
  // 1. Create the table via pg-meta query endpoint
  const sql = `
    CREATE TABLE IF NOT EXISTS public.feedbacks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
      title text NOT NULL,
      description text NOT NULL,
      screenshot_path text,
      status text NOT NULL DEFAULT 'pending',
      submitted_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz,
      system jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS idx_feedbacks_submitted_at
      ON public.feedbacks (submitted_at DESC);
  `.trim();

  // Try pg-meta API
  console.log('Creating feedbacks table...');
  let res = await fetch(`${SUPABASE_URL}/pg-meta/default/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ query: sql }),
  });
  let text = await res.text();
  if (res.ok) {
    console.log('✅ pg-meta success:', text.slice(0, 100));
  } else {
    console.log(`⚠ pg-meta ${res.status}: ${text.slice(0, 200)}`);

    // Try management API directly? No, that needs PAT.
    // Try using the supabase REST API with raw query via accept header
    console.log('Trying REST API with Prefer header...');
    res = await fetch(`${SUPABASE_URL}/rest/v1/feedbacks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Prefer': 'resolution=merge-duplicates',
      },
    });
    text = await res.text();
    console.log(`REST POST result ${res.status}: ${text.slice(0, 200)}`);
  }

  // 2. Verify
  console.log('\nVerifying...');
  res = await fetch(`${SUPABASE_URL}/rest/v1/feedbacks?select=id&limit=1`, {
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
  });
  text = await res.text();
  console.log(`Verify ${res.status}: ${text.slice(0, 200)}`);
  if (res.ok) console.log('✅ Table is accessible!');
}

main().catch(console.error);
