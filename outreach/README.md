# AXON hotel outreach

Daily introduction emails to boutique hotels, sent from venus@axonaisystems.com.
`leads.csv` is the single record of who was contacted; never write to an address already in it.
Email texts: `templates.md`.

## Selection criteria
1. Boutique and independent: roughly under 40 rooms, not part of a chain.
2. Has its own website (the assistant is installed there).
3. The email address is published on the hotel's own website. Never guessed, never scraped from OTAs.
4. Tourism areas with many foreign guests: Alaçatı, Cappadocia, Kaş/Kalkan, Istanbul old city,
   Assos/Ayvalık, Bodrum; abroad Greek islands, Portugal, Spain.
5. Language: Turkish for hotels in Turkey (English when the hotel is foreign-run), English abroad.
6. Skip countries that require prior consent for B2B email (e.g. Germany, Austria).
7. Lower priority if the site already has a chatbot or live chat; a plain WhatsApp link is a good sign
   (messages wait for a person).

## Rules
- One hotel per email, written to its own address; one honest sentence about that hotel.
- Every email names the sender and offers opting out ("çıkar" / "unsubscribe").
  An opt-out reply → status `optout`, never contact again.
- No follow-up sooner than 5 working days; at most one follow-up.
- Status values: draft, sent, replied, demo, optout, bounced.

## Before sending in bulk
axonaisystems.com must resolve with MX, SPF, DKIM and DMARC records, otherwise mail lands in spam
and replies never arrive.
