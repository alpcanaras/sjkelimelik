// Fill these in after creating the Supabase project (Project Settings → API).
// The anon/publishable key is meant to be public: the database rules (RLS + functions) are what protect the data.
export default {
  SUPABASE_URL: 'https://jbfjdpxbfpcycxctvaaw.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpiZmpkcHhiZnBjeWN4Y3R2YWF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIyNDU0MjYsImV4cCI6MjEwNzgyMTQyNn0.LfIvJsZIUJeWGmcEdpcPjFDhjnSEL1FEDcnqdba8zs0',

  // Leave empty to use the crest uploaded to Supabase Storage as branding/crest.png
  // (it is not stored in the public repository). Any other image URL works too.
  CREST_URL: '',

  // Logins are "username + password". Supabase needs an email per account, so each username maps to
  // <username>@AUTH_EMAIL_DOMAIN. ".invalid" is reserved and can never receive mail. Do not change after launch.
  AUTH_EMAIL_DOMAIN: 'kullanici.sjkelimelik.invalid'
};
