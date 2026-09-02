# Archived

`warranty-form-2025.html` is the original single-page warranty claim form,
kept here for reference only. **Do not put it back into service.**

It has two faults that the platform in this repository replaces:

1. It collected the full card number, expiry and CVV, then pasted a partially
   masked version into an email body. Card data must never be handled this
   way — the platform does not ask for card details at all. Where a payment is
   genuinely needed (out-of-warranty work, freight), take it through the normal
   CHES payment channel after the cost is agreed.
2. It posted directly to `api.anthropic.com` from the browser with no
   credentials, so submissions never actually reached anyone. Claims now go
   through the server, which records them in the database and emails CHES.
