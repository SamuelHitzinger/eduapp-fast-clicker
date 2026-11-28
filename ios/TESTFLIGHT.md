# iPhone beta through TestFlight

TestFlight lets up to 10,000 testers install the iPhone app from a link, with automatic updates and no 7-day
expiry. It needs the paid Apple Developer Program (99 USD/year), which an App Store release needs anyway.

## One-time setup (the account owner)

1. **Join the Apple Developer Program** at developer.apple.com/programs (individual is fine). Apple's approval can take a day or two.
2. **Create the app record** in App Store Connect → Apps → **+** → New App:
   - Platform iOS, name e.g. "Clicker for EduApp" (the name must be unique in the store), language English,
   - Bundle ID: register `ch.students.clicker` first under Certificates, IDs & Profiles → Identifiers (App ID, no capabilities needed),
   - SKU: anything, e.g. `clicker`.
3. **Create an API key** for the automatic upload: App Store Connect → Users and Access → Integrations → App Store Connect API → **+**,
   role **Admin** (App Manager is not enough: Apple's cloud signing needs Admin). Download the `.p8` file (only possible once) and note the **Key ID** and **Issuer ID**.
4. Give Claude (or add yourself under GitHub → Settings → Secrets and variables → Actions) these four repository secrets:
   - `APPLE_TEAM_ID` (Membership details → Team ID),
   - `ASC_KEY_ID`, `ASC_ISSUER_ID`,
   - `ASC_KEY_P8_B64` = the `.p8` file base64-encoded (PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("AuthKey_XXXX.p8"))`).
   Keep the `.p8` file somewhere safe and never commit it.

## Each beta build

1. `node tools/release.js ios` (or GitHub → Actions → **iPhone app to TestFlight** → Run workflow, on `main`). It picks the newest Xcode (Apple requires the iOS 26 SDK or later), archives, signs and uploads, then waits for Apple's processing and runs `node tools/testflight.js distribute`: the build goes into the external group with a "What to test" note and is submitted for beta review. `node tools/testflight.js status` shows every build's state.
2. Who gets it when:
   - **Internal testers**: the group "Clicker Tests", up to 100 people who are members of your App Store Connect team (Users and Access).
     They get every build as soon as Apple has processed it, with no review.
   - **External testers**: the group "Beta testers", joined through its public link https://testflight.apple.com/join/YKwXYAN5.
     They get a build once Apple's **Beta App Review** has approved its version. The first version usually takes a day or more;
     later builds of an approved version usually pass by themselves.
3. Once the first build is approved, put the public link into `tools/testflight-url.txt`. `node tools/build.js` and
   `node tools/publish-site.js` then show "Get it on TestFlight" on the install page.

## Before an App Store release

Read the "Store release" section of `../fast-clicker/README.md`: ETH's permission (API use, name), the privacy declarations
(the relay sees IP addresses), and Apple's rules for apps built around a website (guideline 4.2) all matter.
