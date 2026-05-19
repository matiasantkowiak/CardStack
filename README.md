# Cardstack — Grading EV Web App

Risk-adjusted expected value calculator for sports card grading decisions.

## How to put this on the internet (the no-code path)

Follow these steps in order. Each one takes 2–5 minutes.

### Step 1 — Make accounts

You need two free accounts. Sign up for both before continuing:

1. **GitHub** — https://github.com → Sign up. Pick any username (this will be public).
2. **Vercel** — https://vercel.com → Sign up → choose **"Continue with GitHub"** when it asks.

### Step 2 — Put the code on GitHub

1. Go to https://github.com/new (you must be logged in).
2. Under **Repository name**, type `cardstack` (or any name you like).
3. Leave everything else at defaults. Make sure it's set to **Public**.
4. Click **Create repository**.
5. You'll land on a page with setup instructions. **Ignore them.** Instead, look for the link near the top that says **"uploading an existing file"** — click it. (If you don't see that link, click the **"Add file"** button and choose **"Upload files"**.)
6. Open the folder where you unzipped this project. **Select every file and folder inside it** (including the hidden `.gitignore` file — on Mac press Cmd+Shift+. to see hidden files; on Windows, enable "Hidden items" in File Explorer's View menu).
7. Drag everything into the upload area on GitHub.
8. Scroll to the bottom and click **Commit changes**.

You should now see all the files (`package.json`, `src/`, `index.html`, etc.) listed on your GitHub page.

### Step 3 — Deploy with Vercel

1. Go to https://vercel.com/new
2. You'll see a list of your GitHub repositories. Find the one you just made (`cardstack`) and click **Import** next to it.
3. Vercel will auto-detect that it's a Vite project. **Don't change any settings.**
4. Click **Deploy**.
5. Wait 1–2 minutes. You'll see a confetti animation when it's done.
6. Click **Continue to Dashboard** or the preview image — you now have a live URL like `cardstack-abc123.vercel.app`.

**That's it.** Bookmark the URL on your phone and computer. It's now your tool, available 24/7.

### Step 4 (optional) — Make the URL nicer

Vercel will give you a generic URL. To customize it:

1. From the Vercel project dashboard, click **Settings → Domains**.
2. Type whatever you want as a subdomain, e.g. `mygrading` → you'll get `mygrading.vercel.app`.
3. Click **Save**.

If you want a *real* domain like `mycards.com`, you'd buy one from Namecheap (~$12/year) and follow Vercel's instructions to connect it. Not necessary unless you want to.

## How to make changes later

If you ever want to tweak the app (change tier prices, edit a number, etc.):

1. Open the file on GitHub directly (click the file → click the pencil icon).
2. Make your edit.
3. Click **Commit changes** at the bottom.
4. Vercel will auto-redeploy in about 60 seconds. Your URL stays the same.

You never have to touch a terminal.

## What's in this project (FYI, you don't need to understand any of this)

- `src/App.jsx` — the calculator itself
- `src/main.jsx` — boilerplate that loads the calculator into a webpage
- `src/index.css` — styling
- `index.html` — the webpage shell
- `package.json` — list of tools the app uses
- `vite.config.js`, `tailwind.config.js`, `postcss.config.js` — build settings

## If something goes wrong

- **GitHub upload won't accept files** — try uploading the inner files only (not the outer folder).
- **Vercel build fails** — check that all the files made it to GitHub. Especially `package.json` and the `src/` folder. The `node_modules` folder should NOT be uploaded (it's huge and not needed; the `.gitignore` keeps it out).
- **Calculator opens but looks broken** — try a hard refresh (Ctrl+Shift+R on Windows, Cmd+Shift+R on Mac).
- **Watchlist disappeared** — the watchlist is saved in your browser, not the cloud. It stays on the device you saved it from. Clear browser data wipes it.
