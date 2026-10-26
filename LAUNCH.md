# Getting SafeTemp on the App Store

The code is ready. What's left needs your accounts, which only you can create and sign in to.
Do the steps in order; each one unlocks the next.

## 1. Put the code on GitHub (free)

1. Make an account at github.com (if you don't have one).
2. Create a new **private** repository called `safetemp`.
3. Upload the `SafeTemp` folder (everything except `node_modules` folders; the `.gitignore` files already leave out private files).

## 2. Host the server (about $7–8/month)

The phone app loads SafeTemp from your server, and the server checks alerts every 10 minutes, so it has to stay on.

1. Make an account at render.com and connect your GitHub.
2. **New → Blueprint →** pick the `safetemp` repo. Render reads `render.yaml` and sets everything up (always-on server + a small disk for alert subscriptions).
3. When it asks for the secret values:
   - `PUSH_CONTACT`: `mailto:` followed by your real email (push services require a contact).
   - `ANTHROPIC_API_KEY`: optional; leave blank unless you want the AI advice card.
4. When it's live, copy your address (like `https://safetemp.onrender.com`). Open it in a browser to check it works.
5. Put that address in `mobile/eas.json`, replacing `https://REPLACE-WITH-YOUR-SERVER-ADDRESS/` (keep the `/` at the end).

> The first start takes ~3 minutes to gather world weather for the map.

## 3. Expo account (free)

1. Make an account at expo.dev.
2. In a terminal in the `mobile` folder, run `npx eas-cli@latest login` and sign in.
3. Run `npx eas-cli@latest init`. This links the app to your Expo account and turns on push notifications for it.

## 4. Apple Developer Program ($99/year)

1. Enroll at developer.apple.com/programs. **You must be 18+**; otherwise a parent enrolls and the app is published under their name.
2. Approval can take a day or two.
3. Before your first build, decide the app ID in `mobile/app.json` (`ios.bundleIdentifier` and `android.package`, now `com.safetemp.app`). It has to be unique and **can't be changed after the first upload**. Something like `com.yourlastname.safetemp` is safest.

## 5. Build and upload (no Mac needed)

From the `mobile` folder:

1. `npx eas-cli@latest build --platform ios --profile production`
   Expo builds the app in the cloud. The first time, it asks to sign in to your Apple account and sets up the certificates and push keys for you.
2. `npx eas-cli@latest submit --platform ios --latest`
   Uploads it to App Store Connect.

## 6. Test with TestFlight, then submit

1. In App Store Connect (appstoreconnect.apple.com), open SafeTemp → **TestFlight**, add yourself as a tester, and install it on your iPhone with the TestFlight app.
2. Test: location, the When bar, the map, **Turn on alerts → Send a test**.
3. Fill in the App Store listing: description, screenshots (iPhone 6.9" and 6.5"), category **Weather**, age rating, and the **privacy policy URL**: your server address + `privacy.html` (for example `https://safetemp.onrender.com/privacy.html`).
4. Privacy answers ("App Privacy"), matching that page:
   - **Location:** collected only when alerts are on; used for app functionality; not linked to identity; no tracking.
   - **Health:** a typed condition is sent to the server to be assessed and isn't stored. If you turn on AI advice, it's also passed to Anthropic. Answer Apple's questions with that in mind.
   - Names, ages and saved people never leave the phone.
5. Submit for review. It usually takes 1–3 days.

## Testing on your phone before all this

- **Expo Go (quick look):** in the `mobile` folder run `npx expo start --lan --go`, scan the QR code with Expo Go. Phone and computer must be on the same Wi-Fi with the server running. Push alerts don't work in Expo Go on Android.
- **Full test with alerts (after step 3):** `npx eas-cli@latest build --profile development --platform android` gives an installable test app with real notifications.

## Good to know

- **Weather data:** Open-Meteo's free plan is for non-commercial use, about 10,000 calls a day. A free app with no ads is a gray area; if you add ads or charge, get their paid plan.
- **US only:** official alerts (icons, notifications) come from the US National Weather Service.
- **Private files on the server:** `push-keys.json` and `push-subs.json`. Never share them. If the push keys are lost, everyone has to turn alerts on again.
