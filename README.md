# request-test-AH-AY

Checks the two teachers' courses every 12 hours and posts new lesson videos to the WhatsApp group `TTTTT`. Each teacher gets a separate message, split into parts of 50 videos when needed. If nothing is new it sends `ملقيتش حاجة`.

## Setup

Add these repository secrets:

- `API_AUTHORIZATION` — bearer token (without `Bearer`)
- `API_KEY`
- `BOT_STATE_KEY` — long random string, keep it stable

Optional: `WHATSAPP_GROUP_ID` secret, `WHATSAPP_GROUP_NAME` and `TEACHER_IDS` variables.

## Pair WhatsApp once

Pair locally so the QR/pairing code never appears in this public repo's logs.

```bash
npm install
cp .env.example .env
npm run pair
```

Scan the QR in WhatsApp under Linked devices, or put `WHATSAPP_PHONE_NUMBER` in `.env` to use an 8-digit code instead. The encrypted session is uploaded automatically; if not, run `npm run state:save`.

Then run the **Check for new videos** workflow once manually. After that it runs at 00:00 and 12:00 Cairo time (UTC+2).

Tick `force_send` when starting the workflow manually to post the full video list even when nothing is new. `dry_run` checks the API without sending.

## Commands

```bash
npm run inspect -- --videos   # crawl the API and list everything
npm run inspect -- --message  # preview the full message
node src/index.js --dry-run   # full check without WhatsApp or state changes
npm test
```

## Notes

State and the WhatsApp session are stored in an encrypted asset on the `bot-state` release. The key is `BOT_STATE_KEY`; don't delete the release.

The first run only seeds the 180 existing videos and sends `ملقيتش حاجة`, so it doesn't spam the group.

If WhatsApp logs out or the session expires, run `npm run pair` again.
