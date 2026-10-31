# Phone ke browser me kaise khelein

Game seedha phone ke browser (Chrome, Safari, Samsung Internet) me chalta hai. Koi app download nahi karni. Do tareeke hain:

|                              | Kab use karein                                       | Kya chahiye                                                                              |
| ---------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **A. Ghar ke Wi-Fi par**     | Aaj hi, abhi khelna hai; dost bhi usi Wi-Fi par hain | Ek computer (Node.js 20+) aur phone, dono same Wi-Fi par                                 |
| **B. Internet par (deploy)** | Dost alag-alag jagah se khelenge                     | Free deploy, 10-15 minute ka kaam ([DEPLOY_GUIDE_HINGLISH.md](DEPLOY_GUIDE_HINGLISH.md)) |

Practice mode (bots ke against) dono me chalta hai, aur page ek baar khul jaye to bina internet ke bhi chalta hai.

---

## A. Ghar ke Wi-Fi par (ek command)

Computer par, project folder me:

```bash
npm install        # sirf pehli baar
npm run phone
```

Terminal me aisa dikhega:

```
  TANK CLASH is running.

  On this computer:  http://localhost:8080
  On your phone:     http://192.168.1.5:8080

  Scan with the phone camera (phone must be on the same Wi-Fi):
  [QR code]
```

1. Phone ke **camera** se QR code scan karo (ya `http://192.168...` wala link phone ke browser me type karo).
2. Game khul jayega. **Play with friends** dabao → **Share on WhatsApp**: jo dost usi Wi-Fi par hain, link khol ke join kar lenge.
3. Band karna ho to computer par `Ctrl + C`.

**Phone par link nahi khul raha?**

- **Windows:** pehli baar "Allow Node.js through firewall" ka popup aata hai, usme **Private networks** par Allow dabao. Popup miss ho gaya to: Windows Security → Firewall → "Allow an app through firewall" → Node.js ko Private par tick karo.
- Phone aur computer **same Wi-Fi** par hone chahiye (phone ka mobile data band karke dekho). "Guest" Wi-Fi aksar devices ko aapas me baat nahi karne deta.
- Port busy ho to: `npm run phone -- --port 9000`

---

## Phone par khelna: controls

- **Phone ko tircha (landscape) karo.** Android Chrome par "Rotate & go fullscreen" button screen ko fullscreen + landscape kar deta hai. Match shuru karte hi game khud bhi yeh try karta hai.
- **Left thumb:** screen ke left hisse me kahin bhi drag karo. Tank us direction me ghoom ke chalega.
- **Right thumb:** laal **Fire** button. Neela button special ability (Rapid Fire / Shield / Speed Boost) hai.
- Dono ek saath chalte hain (multi-touch).
- **Pause:** upar right ka ❚❚ button. Wahan Sound on/off aur Fullscreen bhi hain.
- Settings me **joystick sensitivity** kam-zyada kar sakte ho.

**iPhone (Safari):** iPhone par browser fullscreen allow nahi karta. Browser ki bars hatane ke liye Safari me **Share → "Add to Home Screen"** karo aur game home screen icon se kholo. Isse yeh app jaisa poori screen par chalega. (Home-screen install ke liye site `https://` par honi chahiye, yaani deploy wali; Wi-Fi wala `http://192.168…` link normal browser tab me hi chalega.)

**Android:** deploy ki hui site par menu me **Install app** button aata hai (ya Chrome menu → "Add to Home screen").

---

## B. Internet par (dost kahin se bhi khelein)

[DEPLOY_GUIDE_HINGLISH.md](DEPLOY_GUIDE_HINGLISH.md) follow karo. Deploy ke baad apne link ko ek command se check kar sakte ho: desktop aur phone dono ke tests aapki live site par chalenge.

```bash
npx playwright install chromium     # sirf pehli baar
npm run test:url -- https://aapka-game-url
```

Yahi command Wi-Fi wale link par bhi chalti hai: `npm run test:url -- http://192.168.1.5:8080`
