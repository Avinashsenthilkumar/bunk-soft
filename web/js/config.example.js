/* ============================================================================
   Copy this file to config.js and fill in your own project.
   Find both values under Project Settings -> API in the Supabase dashboard.

   The anon key belongs in a browser — it identifies the project, not a user,
   and row-level security is what protects the data. Two rules stand, though:

     1. Never put the service_role key here. It bypasses every policy. In
        BunkSoft nothing needs it: creating logins happens inside the database,
        in the security-definer functions in supabase/admin.sql.

     2. The URL must be your own project. A build pointed at someone else's
        Supabase would collect every password typed into it, which is why
        db.js ignores any stored override once this file is filled in.

   On Netlify, Vercel or Cloudflare Pages you can generate this file at build
   time instead of committing it:

     Build command:  node scripts/write-config.mjs
     Environment:    SUPABASE_URL, SUPABASE_ANON_KEY
   ========================================================================== */
window.BUNKSOFT_CONFIG = {
  supabaseUrl:     'https://YOUR_PROJECT.supabase.co',
  supabaseAnonKey: 'YOUR_ANON_PUBLIC_KEY'
};
