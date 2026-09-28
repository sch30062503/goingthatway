# Going That Way v1 – setup guide

About 20 minutes. Everything here is free.

## 1. Supabase (the database)

1. Go to supabase.com, sign up, and click **New project**.
   - Name: `goingthatway`
   - Region: **Sydney** (closest to NZ)
   - Save the database password somewhere safe. You won't need to give it to anyone.
2. When the project is ready, open **SQL Editor** → **New query**. Paste in the whole of `supabase/schema.sql` and click **Run**. It should say "Success".
3. Go to **Authentication** → **Sign In / Providers** and turn on **Allow anonymous sign-ins**. This lets people post without creating an account.
4. Create your admin login: **Authentication** → **Users** → **Add user** → **Create new user**. Enter your email and a strong password, and tick **Auto Confirm User**.
5. Make that login an admin. Back in **SQL Editor**, run this with your email in it:

   ```sql
   update public.profiles set is_admin = true
     where id = (select id from auth.users where email = 'you@example.com');
   ```

6. Go to **Project Settings** → **API** and copy two things:
   - **Project URL**
   - **anon public** key

   These go into `config.js`. They're safe to be public. **Never share the `service_role` key or your database password.**

## 2. GitHub (hosting the site)

1. Sign up at github.com.
2. Click **New repository**. Name it `goingthatway`, set it to **Public**, and click **Create repository**.
3. Click **uploading an existing file**. Drag in every file from this folder (keep the `supabase` folder too), then click **Commit changes**.
4. Go to **Settings** → **Pages**. Under "Build and deployment", choose **Deploy from a branch**, then branch **main**, folder **/ (root)**, and click **Save**.
5. After a minute or two, the page shows your site's address, something like `https://yourname.github.io/goingthatway/`.

## 3. Check it works

- Open the site on your phone. Post a test job and a test trip.
- Open `…/goingthatway/admin.html` and sign in with your admin email and password.
- Your test posts should be under **To approve**. Approve both, match the job to the trip, and check that the public **Board** shows them without names, numbers or addresses.
- Cancel the test posts from **My posts** on your phone when you're done.

## Day to day

1. New posts appear in admin under **To approve**.
2. Tap **Copy confirm text**, send it from your phone, and **Approve** once they reply.
3. Open jobs show **Drivers on this route**. Tap **Match**, then copy the texts to the driver and the sender.
4. After delivery, set the job to **delivered**. Take payment with a payment link or bank transfer for now.

## Before a public launch

- Buy a domain and point it at GitHub Pages (Settings → Pages → Custom domain).
- Turn on CAPTCHA for sign-ins in Supabase (Authentication → Attack Protection) to block spam.
- Get the goods-in-transit insurance and proper terms and conditions from a lawyer.
