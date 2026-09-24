# Musings Studio

A notes and card-deck app for "Come, Follow Me" Musings. It runs in the browser, installs on a phone like an app, works offline, and can sync to Google Drive.

In the steps below, replace `laustenfaund` with your GitHub username.

---

## Step 1. Put the app online (GitHub Pages)

1. Open the **MusingsStudio** repo on GitHub.
2. Click **Add file → Upload files**. Drag in everything from this folder: `index.html`, `app.js`, `drive.js`, `config.js`, `sw.js`, `manifest.webmanifest`, `README.md`, and the `icons` and `vendor` folders. Then click **Commit changes**.
3. Go to **Settings → Pages**. Under **Build and deployment**, set **Source** to **Deploy from a branch**, the branch to **main**, and the folder to **/ (root)**. Click **Save**.
4. After a minute or two, the app is live at:
   `https://laustenfaund.github.io/MusingsStudio/`

The app works at this point. Drive sync starts working after Steps 2 and 3.

---

## Step 2. Set up Google (one time, about 15 minutes)

One Google Cloud project covers **both** apps, Musings Studio and Molly's Note Goat. Do this in your own Google account. Molly never has to enter anything. She signs in with her own Google account inside each app, and her files go only to her own Drive and Calendar.

1. Go to **console.cloud.google.com** and create a new project named **Molly's Apps**.
2. Open **APIs & Services → Library**. Search for and **Enable** each of these:
   - **Google Drive API** (both apps)
   - **Google Picker API** (Musings Studio)
   - **Google Sheets API**, **Google Docs API**, **Google Calendar API** (Note Goat)
3. Open **Google Auth Platform** (it may be labelled **OAuth consent screen**).
   - **Branding:** app name **Molly's Apps**, plus your email for support and contact.
   - **Audience:** choose **External**. Under **Test users**, add Molly's Gmail address (and yours if you want to test it).
   - **Data access:** click **Add or remove scopes** and add both of these:
     - `https://www.googleapis.com/auth/drive.file`, which lets the apps see only the files they create and the files she picks, never the rest of her Drive
     - `https://www.googleapis.com/auth/calendar.events`, which lets Note Goat add appointments to her calendar
4. **Clients → Create client**
   - Application type: **Web application**
   - **Authorized JavaScript origins:** add `https://laustenfaund.github.io`. This one entry covers both apps.
   - Click **Create**, then copy the **Client ID**.
5. **APIs & Services → Credentials → Create credentials → API key**
   - Click the new key to edit it.
   - **Application restrictions:** Websites → add `https://laustenfaund.github.io/*`
   - **API restrictions:** Restrict key → select **Google Picker API, Google Drive API, Google Sheets API, Google Docs API, Google Calendar API**.
   - Save, then copy the key.
6. Find the **project number** under **IAM & Admin → Settings**, or on the project dashboard.

While the project is in **Testing**, Google shows Molly a "Google hasn't verified this app" screen the first time she connects. She taps **Continue**. That is normal for a private app.

## Step 3. Paste the keys into both apps

In the repo, open `config.js`, click the pencil icon to edit it, and replace the three placeholders with your values:

```js
GOOGLE_CLIENT_ID: "1234...apps.googleusercontent.com",
GOOGLE_API_KEY: "AIza...",
GOOGLE_APP_ID: "123456789012"
```

Click **Commit changes**.

For **MollyNoteGoat**, open `index.html` in that repo, find `BUILTIN_GOOGLE` (search the page for it), and paste the same Client ID and API key there:

```js
const BUILTIN_GOOGLE = {
  clientId: '1234...apps.googleusercontent.com',
  apiKey:   'AIza...',
};
```

These values are not secrets. They only work from your GitHub Pages address.

---

## Step 4. On Molly's phone

1. Open `https://laustenfaund.github.io/MusingsStudio/`
2. Put it on the home screen:
   - **iPhone:** in Safari, tap **Share → Add to Home Screen**.
   - **Android:** in Chrome, tap **Install app** (or menu → **Add to Home screen**).
3. Open the app from its icon. Go to **Library → Connect Google Drive** and sign in.

---

## What goes into her Drive

The app creates this folder and keeps it up to date:

```
Musings Studio/
  musings-data.json      her notes, decks, card types, templates, fonts list
  Notes.txt              her notes as plain text, readable in Drive
  Photos and fonts/      every photo and font the app uses
  Decks/
    Week of Sep 20/      exported card images (from Export → Save to Drive)
```

- Sync happens automatically a few seconds after changes, and when the app is opened.
- If two devices both change things before syncing, the app asks which version to keep.
- **From Drive** buttons (in Notes, on a card's Background tab, and under Fonts) open Google's file picker so she can bring in any photo or font from her Drive.

## Privacy

- Her data goes straight between her browser and her Google Drive. It never passes through GitHub or anyone else.
- The code in this repo is public, but none of her content is ever stored here.
- The app can't see the rest of her Drive.

## Updating the app

Upload the changed files to the repo again. Open copies of the app pick up the new version the next time they start with an internet connection.
