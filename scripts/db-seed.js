/**
 * Apply every migration in order, then the demo seed.
 *
 *   node scripts/db-seed.js              migrations + seed
 *   node scripts/db-seed.js --schema     migrations only
 *
 * Runs through the Supabase Management API using SUPABASE_ACCESS_TOKEN from
 * .env, so it needs no local Postgres client. Migrations are written to be
 * re-runnable, and the seed clears its own demo rows first.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const SEED = path.join(ROOT, 'supabase', 'seed.sql');

function env(key) {
  const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const line = raw.split('\n').find((l) => l.trim().startsWith(`${key}=`));
  if (!line) throw new Error(`${key} missing from .env`);
  const value = line.slice(line.indexOf('=') + 1).trim();
  if (!value) throw new Error(`${key} is empty in .env`);
  return value;
}

const TOKEN = env('SUPABASE_ACCESS_TOKEN');
const REF = env('EXPO_PUBLIC_SUPABASE_URL').replace('https://', '').split('.')[0];

async function run(sql, label) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });

  if (!res.ok) {
    console.error(`  FAIL  ${label}`);
    console.error(`        ${(await res.text()).slice(0, 500)}`);
    process.exit(1);
  }
  console.log(`  ok    ${label}`);
}

async function main() {
  const schemaOnly = process.argv.includes('--schema');
  console.log(`Project: ${REF}\n`);

  console.log('migrations');
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    await run(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'), file);
  }

  if (schemaOnly) {
    console.log('\nSchema applied (seed skipped).');
    return;
  }

  console.log('\nseed');
  await run(fs.readFileSync(SEED, 'utf8'), 'seed.sql');

  // GoTrue reads these as Go strings and rejects NULL with an opaque
  // "Database error querying schema" at sign-in. Inserting auth users directly
  // leaves them null, so they are normalised here rather than in the seed,
  // where the intent would be easy to mistake for noise.
  await run(
    `update auth.users set
       confirmation_token = coalesce(confirmation_token, ''),
       recovery_token = coalesce(recovery_token, ''),
       email_change = coalesce(email_change, ''),
       email_change_token_new = coalesce(email_change_token_new, ''),
       email_change_token_current = coalesce(email_change_token_current, ''),
       phone_change_token = coalesce(phone_change_token, ''),
       reauthentication_token = coalesce(reauthentication_token, '')`,
    'normalise auth token columns',
  );

  const summary = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `select
        (select count(*) from public.organizations) orgs,
        (select count(*) from public.profiles) profiles,
        (select count(*) from public.threat_reports) reports,
        (select count(*) from public.safety_alerts) alerts,
        (select count(*) from public.notifications) notifications,
        (select count(*) from public.sos_events) sos,
        (select count(*) from public.audit_log) audit`,
    }),
  });

  console.log('\n' + JSON.stringify((await summary.json())[0], null, 2));
  console.log('\nDone. Sign in with worker@ / officer@ / admin@saferoute.ai, password Passw0rd!');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
