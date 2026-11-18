# Keys for iPhone

A read-only web app for Safari. It downloads your encrypted `Keys.sqlite` from Google Drive, unlocks it on the phone, and lets you search, view and copy. It never changes the file. Your master password and your passwords never leave the phone.

## 1. Pick where to host it

It's static files, so any HTTPS host works. **Give it an origin of its own**: everything on the same origin can read this app's saved copy and frame it, and every GitHub Pages project of an account shares `https://<your-github-name>.github.io`. So use a custom subdomain (GitHub Pages with a CNAME, e.g. `https://keys.example.com/`), or a GitHub account or organisation that hosts nothing else. The steps below use GitHub Pages with a custom domain. You need the address for step 2.

## 2. Google Cloud setup (once, about 10 minutes)

1. Go to https://console.cloud.google.com and create a project, e.g. "Keys".
2. **APIs & Services → Library**: enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen** (or "Google Auth Platform"):
   - User type **External**, app name "Keys", your email as support and developer contact.
   - **Data access / Scopes**: add `.../auth/drive.readonly` (read-only, so Keys can find `Keys.sqlite`; it never writes).
   - **Audience / Test users**: add your own Google account. Leave the app in **Testing**.
4. **Credentials → Create credentials → OAuth client ID**:
   - Type **Web application**.
   - **Authorized JavaScript origins**: your app's own origin, e.g. `https://keys.example.com`
   - **Authorized redirect URIs**: the full app address, e.g. `https://keys.example.com/` (with the trailing slash).
   - Copy the **Client ID**.

No API key is needed. The client ID is the only Google value in the page; it's public by design and only works from the addresses you listed.

## 3. Build

Create `.env.local` in the project folder (it's gitignored):

```
VITE_GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
```

Then:

```bash
npm run build
```

The app is in `dist-phone/`.

## 4. Publish on GitHub Pages

Create a new public repository named `keys-phone`, then push the built files to it:

```bash
cd dist-phone && git init -b main && git add -A && git commit -m "Keys for iPhone" && git remote add origin https://github.com/<your-github-name>/keys-phone.git && git push -u origin main --force
```

In that repository: **Settings → Pages → Deploy from a branch → main / (root)**.

## 5. On the iPhone

1. Open the address in Safari.
2. **Share → Add to Home Screen**, then open Keys from the Home Screen (not from Safari).
3. **Open from Google Drive** → sign in → unlock. If there's more than one `Keys…sqlite`, choose yours from the list.

From then on it checks Drive for a newer version every time you open it or switch back to it. Google's sign-in lasts about an hour; after that, tap **Check for changes** and continue as yourself. Without a connection it opens the last saved copy.

It locks after 5 minutes idle, or a minute after you leave the app.

## Without Google

**Open from Files instead** works with no setup at all, but it reads a one-time copy: pick the file again to see changes.

## Try it on the computer

```bash
npm run dev
```

Opens on http://localhost:5180. Google sign-in only works on the addresses you allowed in step 2 (add `http://localhost:5180` to both lists to test locally).
