# Deploy guide (Hinglish): ₹0 me game live karo

Yeh guide aapko zero cost par game ko internet par live karne me madad karegi. Card ki zaroorat nahi honi chahiye; agar koi host card maange, to doosra option use karo.

> Note: maine khud deploy nahi kiya hai, kyunki aapke account ke bina possible nahi. Lekin dono raaste (Cloudflare aur Render) ka poora game local machine par unhi runtimes me real browser se test hua hai.

---

## Step 0: ek baar ki tayari (10 min)

1. **Node.js 20+** install karo: https://nodejs.org (LTS version).
2. Zip extract karo, folder me terminal kholo:
   ```bash
   npm install
   npm run dev
   ```
   Browser me `http://localhost:5173` kholo. Do tabs me room bana ke join karke dekho. Sab theek hai to aage badho.
3. **GitHub** par free account banao aur ek **public** repo `tank-clash` banao. Fir:
   ```bash
   git remote add origin https://github.com/<aapka-username>/tank-clash.git
   git push -u origin main
   ```
4. README ke "Deploy" buttons mein apna repo bharne ke liye ek baar chalao, fir commit aur push karo:
   ```bash
   npm run personalize
   git commit -am "Point deploy buttons at my repo" && git push
   ```

---

## Option 1 (best): Cloudflare Workers

**Kyun best:** server kabhi "sota" nahi, pehla player bhi turant connect hota hai. Cloudflare ka network India ke paas bhi hai.

```bash
npx wrangler login            # browser khulega, free Cloudflare account se login karo
npm run deploy:cloudflare     # 1-2 minute, end me aapka URL print hoga
```

URL kuch aisa hoga: `https://tank-clash.<aapka-naam>.workers.dev`. Bas, game live hai. Koi setting ya env variable nahi chahiye.

**Free limits (roz reset hote hain, 5:30 AM IST par):** lagbhag 18 player-ghante ke matches roz. Doston ke saath khelne ke liye kaafi hai. Limit cross hui to online mode us din ruk jayega, par Practice chalta rahega.

**Har push par auto-deploy (optional):** GitHub repo → Settings → Secrets → Actions me do secrets daalo:

- `CLOUDFLARE_API_TOKEN`: Cloudflare → My Profile → API Tokens → "Edit Cloudflare Workers" template se banao.
- `CLOUDFLARE_ACCOUNT_ID`: Workers overview page par milega.

Ab `main` par har push par tests chalenge aur game apne aap deploy hoga.

---

## Option 2: Northflank (server hamesha jaagta rehta hai, roz ki limit nahi)

Cloudflare ki daily limit kam pade, ya normal Node server chahiye, to yeh lo. Northflank ke free **Sandbox** plan mein (unke pricing page ke hisaab se, 29 Oct 2026) 2 services free hain, server sota nahi, aur card nahi maangte. Ek third-party site kehti hai ki signup par card verify ho sakta hai, isliye yeh dhyan rakho.

1. https://northflank.com par GitHub se sign up karo aur ek **Project** banao (India ke paas wala region chuno).
2. **Create new → Service → Combined** chuno, naam do `tank-clash`.
3. Repository mein apna `tank-clash` repo aur branch `main` chuno. Build options mein **Dockerfile** chuno.
4. Networking mein port **8080** ko **HTTP** aur **Public** rakho.
5. Resources default rakho. Environment variable kuch nahi chahiye.
6. **Create service** dabao. Kuch minute mein URL milega: `https://p01--tank-clash--xxxx.code.run`

Har baar `main` par push karoge to apne aap naya version deploy hoga.

---

## Option 3: Render (sirf GitHub se, terminal ki zaroorat nahi)

1. https://render.com par GitHub se sign up karo.
2. **New → Blueprint** → apna `tank-clash` repo chuno → **Apply**.
3. 3-5 minute me URL milega: `https://tank-clash-xxxx.onrender.com`.

**Ek baat dhyan rakho:** free Render server 15 minute koi na khele to so jata hai. Agla player aayega to game "Starting the game server" screen dikhayega (timer ke saath), aur tab tak Practice khelne ka button bhi dega. Ek baar jaag gaya to sab normal chalta hai.

Region default **Singapore** hai (India ke sabse paas). Badalna ho to `render.yaml` me `region` change karo.

---

## Deploy ke baad 2-minute check

1. `https://<aapka-url>/health` kholo. `{"status":"ok", ...}` dikhna chahiye.
2. Laptop par **Play with friends** → **Share on WhatsApp** dabao, ya link copy karke phone par kholo → join karo → match start karo.
3. Phone par menu me **Install app** (ya browser ka "Add to Home screen") se app jaisa install ho jayega.

---

## Agar dikkat aaye

| Problem                                | Solution                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `wrangler login` ka browser nahi khula | Terminal me jo link aaya use manually kholo                                                                          |
| "Could not reach the server"           | Render par ho to 1 minute ruk kar **Try again**; Cloudflare par dashboard me dekho ki daily limit to khatam nahi hui |
| Invite link par 404                    | Static hosting (GitHub Pages) par sirf client hota hai; Option 1 ya 2 use karo                                       |
| Kuch aur                               | `docs/TROUBLESHOOTING.md` dekho                                                                                      |

## Kaun se "free" options ab free nahi hain (Oct 2026)

Fly.io, Koyeb (naye users), Heroku, Glitch, aur Hugging Face Docker Spaces me ab free server nahi milta. Railway sirf trial deta hai. Details aur sources `docs/DEPLOYMENT.md` me hain.
