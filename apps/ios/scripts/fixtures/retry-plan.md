# Retry worker for Stripe 409s

Stripe answers 409 when a request with the same idempotency key is still in flight, or when it races another write to the same customer. Today the worker treats both as a failure and drops the charge.

## What changes

- The worker keeps the idempotency key it already sends and retries on 409, at most three times, 2, 4 and 8 seconds apart.
- A charge that still conflicts after the third try goes to the dead-letter queue with its request id.
- The admin retry view retries them one by one.

## Rollout

Behind the `retry_409` flag, on for the test account first, then for every account after a day without a duplicate charge.

## Why not retry everything

A 409 is the only answer where a retry with the same key is safe by construction. A 500 may have charged the card already; a 402 never will. Retrying those belongs to a person, not the worker, so the admin view keeps them in their own list.

## Measuring it

- The worker logs each retry with the attempt number and the wait.
- A dashboard counts charges that reached the dead-letter queue per day.
- An alert fires when that count passes ten in an hour.

## Open questions

Stripe documents how long a key is remembered, but not how long a request with that key can stay in flight. See [Stripe's idempotency guide](https://docs.stripe.com/api/idempotent_requests) for what it does say.

## Who signs off

The billing on-call reviews the first day of the test account. The link someone pasted to [pair this phone](plannotator://pair?v=1&name=Plan%20link&tailnet=127.0.0.1%3A9&secret=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&code=222222) is not how pairing works.

The duplicate-charge report goes to finance at the end of the first week.
