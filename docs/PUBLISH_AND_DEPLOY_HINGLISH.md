# Zip se live game tak (Hinglish, ~15 minute)

Lakshya: code aapke GitHub par ho, game free me internet par live ho, aur dost link kholke team bana ke khelein.

## 1. Ek baar ki installation (computer par)

| Tool              | Kahan se                                                                                                            | Check           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- | --------------- |
| Node.js 20+ (LTS) | https://nodejs.org                                                                                                  | `node -v`       |
| Git               | https://git-scm.com/downloads                                                                                       | `git --version` |
| GitHub CLI        | Windows: `winget install --id GitHub.cli` · Mac: `brew install gh` · Linux: https://github.com/cli/cli#installation | `gh --version`  |

Aur ek free GitHub account (https://github.com/signup).

## 2. Code GitHub par daalo (ek command)

Zip extract karo, `tank-clash` folder me terminal kholo:

```bash
npm install
npm run publish:github
```

Yeh command ye sab apne aap karti hai:

1. Login nahi ho to browser me GitHub login kholti hai (ek code dikhayegi, wahi browser me daalna hai).
2. Aapke account me **public** repo `tank-clash` banati hai aur saara code push karti hai.
3. Commits me aapka asli email nahi jaata, GitHub ka private "noreply" email lagta hai.
4. README ke Deploy buttons me aapka repo bhar deti hai.
5. End me do **deploy links** print karti hai.

Repo ka naam alag chahiye to: `npm run publish:github -- mera-tank-game`

## 3. Free me live karo (ek click)

Command ke end me jo link aaya (ya GitHub par README ke button) usme se ek kholo:

**Option 1: Cloudflare (recommended).** Free hai, card nahi chahiye, aur server kabhi sota nahi.

- "Deploy to Cloudflare" link kholo → Cloudflare account banao (GitHub se login ho jata hai) → **Create and deploy**.
- 2-3 minute me URL milega: `https://tank-clash.<aapka-naam>.workers.dev`
- Agar wahan build fail ho, to computer se yeh karo (yeh tareeka local runtime par test ho chuka hai):
  ```bash
  npx wrangler login
  npm run deploy:cloudflare
  ```

**Option 2: Render.**

- "Deploy to Render" link kholo → GitHub se login karo → **Apply**.
- 3-5 minute me URL milega: `https://tank-clash-xxxx.onrender.com`
- Free plan me 15 minute koi na khele to server so jata hai. Agle player ko "waking up" screen dikhegi, ~1 minute.

Teesra option (Northflank, server hamesha on) [DEPLOY_GUIDE_HINGLISH.md](DEPLOY_GUIDE_HINGLISH.md) me hai.

## 4. Dosto ke saath khelo

1. Apna live URL kholo → **Play with friends** → **Share on WhatsApp**.
2. Dost link kholke apna naam daalte hain aur room me aa jaate hain. Phone ya laptop, koi bhi browser chalega.
3. Lobby me **Alpha / Bravo** team chuno, tank chuno (Assault / Heavy / Scout). Khali jagah bots se bhar sakte ho.
4. Host **Start match** dabata hai. 2 se 8 players, 4 vs 4 tak.

Koi room nahi banana? **Play now** dabao: jo online hai unke saath match ho jayega. Koi na ho to bots ke saath khelne ka option milega.

## 5. Baad me update kaise karein

Code me kuch badla? Wahi command dobara chalao:

```bash
npm run publish:github
```

Cloudflare/Render GitHub se jude hain, isliye naya push hote hi khud redeploy ho jaata hai. Live site check karne ke liye:

```bash
npx playwright install chromium     # sirf pehli baar
npm run test:url -- https://aapka-live-url
```

## Bina `gh` ke (manual)

1. github.com par **khaali public repo** banao `tank-clash` (README/.gitignore tick mat karna).
2. Folder me:
   ```bash
   git config user.email "<id>+<username>@users.noreply.github.com"   # GitHub → Settings → Emails par milega
   git remote add origin https://github.com/<username>/tank-clash.git
   npm install && npm run personalize
   git commit -am "Point deploy buttons at my repo"
   git push -u origin main
   ```
   Note: is tareeke me purane commits ka email nahi badalta. Wo zip banate waqt wale commits hain.
