# SJ Kelimelik

League and cup manager for the SJ Kelimelik community: fixtures, result entry with opponent confirmation, standings, Elo, group-stage cups with knockout brackets, and an admin panel.

An independent community app. It is not an official school service.

- **Front end:** a static site in plain JavaScript with no build step (`index.html`, `styles.css`, `src/`).
- **Back end:** [Supabase](https://supabase.com) (Postgres, auth, storage), free tier.
- **Hosting:** any static host. GitHub Pages is the simplest.

## How it works

| Who | Can do |
| --- | --- |
| Visitors (no login) | See seasons, fixtures, results, standings, Elo. Only usernames are shown. |
| Pending account | Same as visitors. Waits for an admin to approve. |
| Approved player | Submit the result of their own match, confirm or dispute the opponent's submission, see members' real names. |
| Admin | Approve or reject accounts, enter or correct any result, resolve disputes, create leagues and cups, generate the knockout bracket, add players who have no account, reset passwords, grant admin. |

- **Login:** username and password. The real name is optional and visible only to approved members. Supabase requires an email per account, so the app maps each username to `<username>@kullanici.sjkelimelik.invalid`. That domain is reserved and can never receive mail.
- **Server-side checks:** every write goes through a Postgres function (`supabase/migrations/…_init.sql`) that re-checks who is calling. No table accepts writes from the browser, so the rules hold even if someone edits the front end.
- **Derived numbers:** standings and Elo are calculated in the browser from confirmed results (`src/engine.js`).
- **Audit log:** every action is logged and visible in the admin panel.

## Setup (one time)

1. **Create a Supabase project** at supabase.com (free plan). Pick the region closest to your players (e.g. Frankfurt).
2. **Create the database.** Open the project's **SQL Editor**, paste the whole of `supabase/migrations/20261017000000_init.sql`, and run it.
3. **Turn off email confirmation.** Go to **Authentication → Sign In / Providers → Email**, keep Email enabled, and switch **Confirm email** off. Without this, sign-ups fail, because there is no real inbox to confirm.
4. **Fill in `config.js`.** Copy the **Project URL** and the **anon / publishable key** from **Project Settings → API**. This key is designed to be public.
5. **Upload the crest.** Go to **Storage → branding** (the migration creates this bucket) and upload the crest image named exactly `crest.png`.
6. **Deploy.**
   - **Vercel (current live site):** https://sjkelimelik.vercel.app. Redeploy after changes with `vercel deploy --prod`. `vercel.json` and `.vercelignore` make sure only the site files are uploaded and published.
   - **GitHub Pages (also on):** under **Settings → Pages** choose *Deploy from a branch*, `main`, folder `/ (root)`. The site appears at `https://<user>.github.io/<repo>/`.
7. **Make yourself admin.** Open the site, create your account, then run this in the SQL Editor:
   ```sql
   select private.make_admin('your_username');
   ```
   Reload the site and the **Yönetim** (admin) tab appears. From then on you approve everyone else in the app.

**Running a season:** players sign up, you approve them under **Yönetim**, and then you create a league or cup under **Yeni organizasyon**. If someone played before having an account, add them as a *hesapsız oyuncu* (player without an account). When they later sign up, link their account to that player in the approval dialog, so their history is kept.

## Local development

```bash
npm install
```

```bash
npm test
```

```bash
npm run local
```

- `npm test` runs the engine tests plus database tests. The database tests apply the real migration in PGlite (in-process Postgres) and exercise the access rules through the same roles Supabase uses.
- `npm run local` serves the app at http://localhost:8787 against an in-browser copy of the database seeded with a demo league, with no Supabase account needed. The demo accounts are `alp` (admin), `Ayşe`, `mehmet`, `zeynep` and `ahmet`, all with password `test1234`. Add `?reset` to the URL to start over.

The crest is not in the repository (see `.gitignore`). For local runs, put it at `assets/saint-joseph-crest-cropped.png`.

## Good to know

- **Free-tier pausing:** Supabase pauses free projects after 7 days without any requests. Resuming takes one click in the dashboard. During the off-season, open the site occasionally, or upgrade.
- **Backups:** the admin panel has **JSON yedeğini dışa aktarın** (export a JSON backup). Export after each round, because the free tier has no point-in-time restore.
- **Forgotten passwords:** there is no email, so an admin uses **Şifre sıfırla** (reset password) in the members list and passes the new password on.
- **Changing the schema later:** add a new file in `supabase/migrations/` and run it in the SQL Editor. Don't edit the first migration once it has been applied.
- **The original offline demo** lives in `prototype/` locally and is not committed.
