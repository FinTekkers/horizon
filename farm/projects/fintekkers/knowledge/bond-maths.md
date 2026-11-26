# Bond maths: the fixed-coupon street convention

FinTekkers knowledge library. Written in our own words for golden cases and
reviews; the primary sources are listed at the end. Notation: C is the annual
coupon per 100 face, f the coupons per year, y the annual yield quoted at
frequency f, R the redemption amount per 100 (normally 100).

## 1 Scope {#scope}

This document fixes how FinTekkers prices a plain fixed-coupon bond between
coupon dates: the period fraction, accrued interest, dirty and clean price,
yield, Macaulay and modified duration, convexity and DV01. It is the
convention US Treasuries and US corporates are quoted on, and the one
spreadsheet functions such as PRICE, YIELD and MDURATION implement. Floating,
zero-coupon and callable bonds are out of scope.

## 2 Coupon schedule and the period fraction {#coupon-schedule}

Coupon dates step back from maturity in whole periods of 12/f months, on the
maturity day of the month (end-of-month bonds stay on month ends). For a
settlement date S:

- PCD is the last coupon date on or before S, NCD the first one after S.
- E is the number of days in the period PCD to NCD (actual days for
  ACT/ACT ICMA, see the day-count document).
- A is the accrued days, PCD to S, under the bond's day count.
- DSC is the days from S to NCD, so DSC = E - A.
- w = DSC / E is the period fraction: the part of the current period still
  to run, with 0 < w <= 1.
- n is the number of coupons still to be paid, NCD included.

On a coupon date w = 1 and nothing has accrued. One day before a coupon date
w is close to 0.

## 3 Accrued interest {#accrued}

Accrued interest per 100 face is the coupon earned since PCD:

    AI = (C / f) * A / E

For a bond on 30/360 US, A is the 30/360 day count from PCD to S and E is
360 / f, so a full period is always 180 days for a semiannual bond. The
buyer pays the clean price plus AI. Ex-dividend periods are not modelled.

## 4 The fractional first period {#first-period-stub}

Between coupon dates the first cash flow is only w periods away, not a full
period. Every flow is therefore discounted over k + w periods, where k counts
whole periods from NCD (k = 0 for NCD itself). Treating the first period as a
whole one (discounting over k + 1) mis-states every time to cash flow by
1 - w periods. That error moves yield, duration and convexity together, and it
vanishes only when settlement falls on a coupon date (w = 1), which is why a
test that settles on a coupon date cannot catch it.

An irregular first coupon from issue (short or long first coupon) changes the
amount of the first coupon and how AI is counted inside that period. The
fraction w is still measured inside the notional regular period that contains
S.

## 5 Dirty and clean price {#price}

The dirty (full) price per 100 at yield y is the present value of the
remaining flows, discounted from S:

    P_dirty = sum over k = 0 .. n-1 of (C/f) / (1 + y/f)^(k + w)
              + R / (1 + y/f)^(n - 1 + w)

    P_clean = P_dirty - AI

Quotes are clean; the calculation is done on dirty. When only one coupon is
left (n = 1), US street practice and the spreadsheet functions use simple
interest instead: P_dirty = (R + C/f) / (1 + w * y / f). A golden case in the
final period must say which of the two forms it uses.

## 6 Yield to maturity {#yield}

The yield is the y that makes P_dirty in section 5 equal to the quoted clean
price plus AI. It is quoted annualised at the coupon frequency (a
bond-equivalent yield for a semiannual bond). There is no closed form: solve
numerically. A Newton-Raphson solve on y uses dP/dy from section 8, starts
from the current yield C / P_clean, stops when the price error is below a
stated tolerance (1e-10 per 100 is ample), and reports failure after a capped
number of iterations instead of returning the last iterate.

## 7 Macaulay duration {#macaulay-duration}

Macaulay duration is the present-value-weighted average time to the cash
flows, in years. With t_k = k + w periods and PV_k the discounted value of
flow k at the solved yield:

    D_mac = (1 / f) * (sum of t_k * PV_k) / P_dirty

The weights use the dirty price, the same one the yield was solved on.

## 8 Modified duration {#modified-duration}

Modified duration is the relative price change for a small change in yield:

    D_mod = -(1 / P_dirty) * dP_dirty/dy = D_mac / (1 + y/f)

It inherits the fractional first period from D_mac. A duration built from
whole periods overstates D_mac by (1 - w) / f years before the division, and a
yield solved on the clean price instead of the dirty price shifts it again.

## 9 Convexity and DV01 {#convexity}

Convexity is the second derivative of the dirty price, scaled by price, in
years squared:

    Convexity = (1 / P_dirty) * (1 / f^2)
                * sum of t_k * (t_k + 1) * CF_k / (1 + y/f)^(t_k + 2)

where CF_k is the flow paid at t_k. DV01 is the change in dirty price for a
one basis point fall in yield, per 100 face: DV01 = D_mod * P_dirty * 0.0001.
A central finite difference of P_dirty with a 1bp bump each way is a good
independent check of both.

## 10 Worked example {#worked-example}

A 9.25% semiannual note maturing 1 June 2030 (coupons 1 June and 1 December),
ACT/ACT ICMA, clean price 85.00, settlement 1 March 2027:

- PCD = 1 Dec 2026, NCD = 1 Jun 2027; E = 182 actual days, A = 90.
- w = 92/182 = 0.505495, n = 7.
- AI = 4.625 * 90/182 = 2.287088; P_dirty = 87.287088.
- Solving section 5 gives y = 15.2529%; D_mac = 2.7757; D_mod = 2.5790.

On 30/360 US the same trade has A = 90, E = 180, w = 0.5 and AI = 2.3125,
giving y = 15.2573% and D_mod = 2.5764. These match the hand-computed
reference values recorded for the CoreWeave 9.25% 2030 note in FinTekkers
items LS-237 and LM-498 (25 Nov 2026), which VS-164 must reproduce.

## Sources

- US Treasury, 31 CFR Part 356, Appendix B (price and accrued interest
  formulas for marketable notes and bonds):
  https://www.ecfr.gov/current/title-31/subtitle-B/chapter-II/subchapter-A/part-356
- ICMA Primary Market Handbook and Secondary Market Rules, Rule 251 (accrued
  interest): cited by name only; no text is reproduced here.
- QuantLib, FixedRateBond and BondFunctions documentation (independent
  implementation used for cross-checks): https://www.quantlib.org/
- FinTekkers items LS-237 and LM-498: hand-computed reference values for the
  CoreWeave 9.25% 2030 note.
