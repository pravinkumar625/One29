# Class of ’26 — Portfolio

29 students, 29 portfolio pages, one site. Anyone can browse; only you can edit your own page.

## Run it (Windows / PowerShell)
Needs Node 18+ (`node -v`). No `npm install` needed — zero dependencies.

    cd class-portfolio
    node server.js
    # open http://localhost:3000

Anyone on the same Wi-Fi can open `http://<your-PC-IP>:3000`.

## How it works
- **Sign up** → name, user ID, password (max 29 accounts, then it says the class is full).
- **Log in / Log out** from the top-right pills. Sessions last 30 days (httpOnly cookie).
- **View**: every page is public: `/#/u/<userid>`.
- **Edit**: the server only ever edits the logged-in user's own record, so nobody can edit anyone else's page.
- Passwords are salted + hashed (scrypt). Data lives in `data/db.json` — back it up.
- Forgot password? On the server: `node reset-password.js <userid> <newpassword>`

## Put it online so the whole class can use it
Needs a host that runs Node and keeps a disk (the `data/` folder), e.g. Render or Railway.
- Start command: `node server.js`
- Set `NODE_ENV=production` (Secure cookies; needs HTTPS, which hosts provide).
- Mount a persistent disk and set `DATA_DIR` to its path, otherwise accounts vanish on every redeploy.

## Files
- `server.js` — API, auth, static hosting
- `public/index.html`, `public/style.css`, `public/app.js` — the whole front end
