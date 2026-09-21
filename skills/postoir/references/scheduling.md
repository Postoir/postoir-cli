# Publish, schedule, and monitor

```sh
postoir posts publish POST_ID
postoir posts schedule POST_ID --at 2030-01-15T09:00:00+01:00
postoir posts schedule POST_ID --at 2030-01-16T09:00:00+01:00 # move
postoir posts unschedule POST_ID
postoir posts get POST_ID
postoir posts watch POST_ID --timeout 120000
postoir posts delete POST_ID
```

The scheduled date must be in the future, use ISO 8601, and include an explicit timezone. Publishing and scheduling start an asynchronous operation; acceptance is not proof of delivery. Read the post after acceptance and report every account's status and published link when available.

Move or cancel a schedule only before delivery begins. Cancelling does not restore usage already consumed by scheduling. `posts watch` returns exit `6` for a failed target, `7` when the result needs review, and `8` when monitoring times out. Deletion removes the post from Postoir and cancels pending work, but cannot remove content already published on a social network.
