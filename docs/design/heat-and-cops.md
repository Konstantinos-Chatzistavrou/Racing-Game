# Heat and cops: the system we are building (design brief, 2026-11-09)

Verbatim requirements from the user, kept here so every slice is judged against them.

## The loop

- **Cops are a stake that escalates and can be escaped.**
- **Damage/repair economy**: a wrecked car costs money, not a race restart.
- **Pink slips / wagers**: you can lose the car you tuned.
- **Reputation / heat**: getting caught has a cost beyond the race.
- **Heat is a visible dial, not an invisible ratchet.** The player must always read "4/5 heat" and have a real
  choice: bank and cool down, pay to lay low, or push one more high-payout race. NFS Heat half-did this and then
  punished banking late so brutally that the lesson was "never push". Make the push tempting and the bail possible.
- **Only spawn cops from player actions** - racing, reckless driving in cop-dense zones, entering high-heat events.
  Never while cruising, never in the garage, never while tuning. That keeps the chill session mode.
- **Escape is a skill, not a timer.** Line-of-sight breaks, cooldown zones, losing them in an alley or a parking
  structure. A bar that fills while driving straight is a chore.
- **Short chases beat long ones.** Most encounters should be ~30-second scrambles, not ten-minute pursuits.
- **Busting is a setback, not a wipe.** Impound fee, fine, lost wager, heat reset - the car and the night's other
  progress survive. "Lose the car" is reserved for pink-slip races the player explicitly accepted.
- **High heat pays.** Exclusive events, better parts, bigger purses at 4-5 heat, so cops become a risk/reward dial
  the player turns up on purpose.

## Slices

1. **Heat dial (this slice)** - a visible 0-5 state, gained from player actions (finishing a race; wrecking the car),
   cooling down over quiet minutes, persisted, shown in the HUD every moment of the session. No cops yet.
2. **Cops from actions only** - patrols spawn at 3+ heat when a race ends in a cop-dense block; a 30 s chase with
   line-of-sight escape (distance + occlusion + no line-of-sight for N seconds), bust = fine + impound + heat reset.
3. **The choice** - bank (return to a safehouse zone to cool faster), pay to lay low (credits), push (a 4-5 heat
   event with a bigger purse and better parts).
4. **Wagers / pink slips** - explicit entry, explicit risk, car loss only there.
5. **Damage economy** - repair costs by damage zones; wrecking bills, it does not just restart.

## Slice status

- **Slice 1 - heat dial: DONE.** 0-5 in the HUD and on the title, +1 per finished race and per heavy impact (max one
  per 20 s), cools 90/75/60/45/30 s by level, persisted.
- **Slice 2 - cops: DONE (first pass).** One unmarked car (traffic model) joins a *real race* you started at 3+ heat,
  two seconds in - never free roam, garage, or tuning. It holds a 6 m tail on the route spline. Verified headless:
  bust in 2.8 s with the player stopped (heat 4 -> 0); line-of-sight escape after 3.5 s unseen; a seen cop never
  escapes; it also gives up after 35 s or when the gap holds 140 m for 4 s. HUD shows 🚨 POLICE - gap m, or the
  outcome. Not yet: a light bar / siren, the impound fine, and the bank/pay/push choice (slice 3).
