# TIPS: Treasury Inflation-Protected Securities

FinTekkers knowledge library. Written in our own words from the Treasury's
published rules; the primary sources are listed at the end. A TIPS pays a
fixed real coupon on a principal that is adjusted for inflation by the CPI.

## 1 Scope {#scope}

How the index ratio, the inflation-adjusted principal, coupons, price and
accrued interest of a TIPS are formed, what happens when the CPI is late or
changes, and the deflation floor at maturity.

## 2 Reference CPI {#reference-cpi}

The index is the non-seasonally adjusted CPI-U published by the Bureau of
Labor Statistics. The reference CPI (Ref CPI) for the first day of a month M
is the CPI-U for the month three months earlier: for 1 July it is the April
CPI-U. For any other day of month M it is interpolated in a straight line
between the Ref CPI of the first of M and the first of the next month:

    Ref CPI(date) = Ref CPI(M) + (t - 1) / D * (Ref CPI(M+1) - Ref CPI(M))

where t is the day of the month of the date and D is the number of days in
month M. The regulation fixes the rounding: the result is truncated to six
decimal places and rounded to five.

## 3 Index ratio {#index-ratio}

The index ratio on a date is the Ref CPI on that date divided by the Ref CPI
on the security's dated date (its base CPI, published with the auction):

    Index ratio(date) = Ref CPI(date) / Ref CPI(dated date)

It is also truncated to six decimals and rounded to five. On settlement the
ratio is taken at the settlement date.

## 4 Adjusted principal, coupon, price and accrued {#adjusted-principal}

- Inflation-adjusted principal = par * index ratio.
- Each coupon = (real coupon rate / 2) * inflation-adjusted principal on the
  coupon date.
- Prices and yields are quoted in real terms. The settlement amount per 100
  is (real clean price + real accrued interest) * index ratio at settlement.
- Real accrued interest is computed as for any Treasury note, on ACT/ACT
  ICMA (see the day-count document), then scaled by the index ratio.

## 5 Deflation floor {#deflation-floor}

At maturity the holder receives the greater of the inflation-adjusted
principal and the original par. Coupons are not floored: in a deflationary
period they are paid on the lower adjusted principal. The floor applies only
once, at maturity, so it is an option on cumulative inflation since issue.

## 6 Fallback index {#fallback-index}

If the CPI-U for a month is not reported when it is needed, Treasury uses a
substitute built from the last reported CPI-U and the change over the last
twelve months:

    CPI(missing) = CPI(last) * (CPI(last) / CPI(last, 12 months earlier))^(m / 12)

where m is the number of months between the last reported month and the
missing month. Payments made on a substitute index are not revised when the
real index is published. If the CPI is rebased, Treasury converts it back to
the original base; if it is discontinued or fundamentally changed, Treasury,
after consulting the Bureau of Labor Statistics, chooses an appropriate
replacement index.

## 7 Real yield {#real-yield}

The real yield is solved from the real clean price plus real accrued, with
the fixed-coupon formula in the bond maths document. The index ratio scales
both sides of the price equation, so it does not change the real yield.

## 8 Worked example {#tips-example}

An illustrative calculation with made-up CPI values. Ref CPI for 1 July is
300.00000 and for 1 August is 301.24000; July has 31 days; the base CPI is
295.00000. Settlement on 15 July:

- Ref CPI = 300.00000 + 14/31 * 1.24000 = 300.56000.
- Index ratio = 300.56000 / 295.00000 = 1.01885 (five decimals).
- A real clean price of 99.50 with real accrued 0.40 settles at
  (99.50 + 0.40) * 1.01885 = 101.7831 per 100 face.

## Sources

- US Treasury, 31 CFR Part 356, Appendix B, section I (inflation-protected
  securities: Ref CPI, index ratio, substitute index and the minimum
  principal at maturity):
  https://www.ecfr.gov/current/title-31/subtitle-B/chapter-II/subchapter-A/part-356
- TreasuryDirect, Treasury Inflation-Protected Securities:
  https://www.treasurydirect.gov/marketable-securities/tips/
- US Bureau of Labor Statistics, Consumer Price Index (CPI-U, not
  seasonally adjusted): https://www.bls.gov/cpi/
