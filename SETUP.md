# Going That Way v1 – setup guide

About 20 minutes. Everything here is free.

## 1. Supabase (the database)

1. Go to supabase.com, sign up, and click **New project**.
   - Name: `goingthatway`
   - Region: **Sydney** (closest to NZ)
   - Save the database password somewhere safe. You won't need to give it to anyone.
2. When the project is ready, open **SQL Editor** → **New query**. Paste in the whole of `supabase/schema.sql` and click **Run**. It should say "Success". (It already includes the later updates in `002_payments.sql`, `003_driver_claims.sql` and `004_photos.sql`, so a new project only needs `schema.sql`.)
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
- Your test job is under **Payments to check**: tap **Payment received: go live**. Your test trip is under **New drivers**: tap **verify driver**.
- On your phone, go to **My posts**. Your trip should list the job. Tap **Take it**, then **Collected**, then **Delivered**, and check it appears under **Payouts** in admin.
- Check the public **Board** never shows names, numbers or addresses.
- Cancel the test posts from **My posts** on your phone when you're done.

## Day to day

**Senders** post a job, see the price and pay by bank transfer with their job reference (GTW-XXXXXX).
1. **Payments to check:** when the money arrives, tap **Payment received: go live**. The job goes on the board.

**Drivers** post a trip, often on the morning they're going, and see paid jobs on their route.
2. **New drivers:** a new driver's first trip waits here. Copy the welcome text, check their licence photo and plate, then tap **verify driver**. From then on their trips go live instantly and they can take jobs themselves.
3. Drivers tap **Take it**, text the sender or seller to confirm pickup, then take a **pickup photo** (marks it collected) and a **drop-off photo** (marks it delivered). Photos show on the job in admin and in the sender's My posts. You don't need to do anything.
4. **Payouts:** delivered jobs appear here with each driver's total. Pay them by bank transfer, then tap **Mark all paid**.

**If something goes wrong**
- No driver by the deliver-by day: copy the "no driver yet" text and offer more days, meeting on the route, or a full refund.
- No-show at pickup: set the job to **no_show**, refund the sender minus the driver's pay, and set payment to **part_refunded**. The driver's pay appears in Payouts.
- Senders can cancel until a driver takes the job. After that, they need to contact you.

## Before a public launch

- Buy a domain and point it at GitHub Pages (Settings → Pages → Custom domain).
- Turn on CAPTCHA for sign-ins in Supabase (Authentication → Attack Protection) to block spam.
- Get the goods-in-transit insurance and proper terms and conditions from a lawyer.
