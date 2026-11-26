# Day-count conventions

FinTekkers knowledge library. Written in our own words; the primary sources
are listed at the end. A day count turns two dates into a number of days and
a year fraction. It decides accrued interest and, for ACT/ACT ICMA, the period
fraction w used in the bond maths document.

## 1 Terms {#terms}

- D1, M1, Y1 are the day, month and year of the start date; D2, M2, Y2 of the
  end date. The start date is included and the end date is not.
- ACT means actual calendar days between the two dates.
- f is the number of coupon periods per year.
- A day count is a property of the bond. The ledger-models field
  BondDetailsProto.day_count (LM-498) carries it; when unset, the product
  default in section 8 applies.

## 2 ACT/ACT ICMA {#act-act-icma}

Used for US Treasury notes and bonds, and for most government bonds. Within
one regular coupon period from PCD to NCD:

    accrual fraction = ACT(PCD, S) / ACT(PCD, NCD)
    year fraction    = ACT(PCD, S) / (f * ACT(PCD, NCD))

So the denominator is the actual length of the period the date falls in, never
a fixed 365 or 366. A semiannual period can be 181 to 184 days long. For an
irregular period, split it into the notional regular periods it overlaps and
add the fractions of each.

Example: 1 Dec 2026 to 1 Mar 2027 inside the period ending 1 Jun 2027 is
90 / 182 of a period, a year fraction of 90 / 364.

## 3 Thirty/360 US (30/360, bond basis) {#thirty-360-us}

Written 30/360 US. Used for US corporate and agency bonds. Every month
counts as 30 days:

    days = 360 * (Y2 - Y1) + 30 * (M2 - M1) + (D2 - D1)

after these adjustments, in order:

- if D1 is 31, set D1 to 30;
- if D2 is 31 and D1 (after the first rule) is 30 or 31, set D2 to 30.

The year fraction is days / 360. There is no February end-of-month rule in
the FinTekkers definition (LM-498). Some systems, including the spreadsheet
basis 0, add one; results differ when a date is the last day of February.

## 4 ACT/360 {#act-360}

Actual days over 360. Used for Treasury bills and money-market instruments.
A full year is therefore slightly more than 1.0 (365/360).

## 5 ACT/365 Fixed {#act-365f}

Actual days over 365, in every year, leap years included. Used for some
money-market and sterling instruments and for many curve-building
conventions.

## 6 Month ends {#month-end}

Month ends are where the conventions disagree most. Worked values, start date
included, end date excluded:

    from         to           ACT   30/360 US   ACT/360        ACT/365F
    2027-02-28   2027-03-31   31    33          0.0861111111   0.0849315068
    2028-02-29   2028-03-31   31    32          0.0861111111   0.0849315068
    2026-01-31   2026-03-31   59    60          0.1638888889   0.1616438356
    2026-01-30   2026-03-31   60    60          0.1666666667   0.1643835616
    2026-03-31   2026-04-01   1     1           0.0027777778   0.0027397260
    2026-12-01   2027-03-01   90    90          0.2500000000   0.2465753425

The first two rows show the missing February rule: 28 Feb and 29 Feb are not
moved to 30, so 30/360 US counts 33 and 32 days.

## 7 Leap years and negative rates {#edge-cases}

ACT/ACT ICMA needs no leap-year rule, because the period length already
contains 29 February when it falls inside. ACT/365F does not adjust, so a
leap year accrues 366/365 of the annual amount. A day count never changes
sign: with a negative rate, accrued interest is negative and the day count is
unchanged.

## 8 Product defaults {#product-defaults}

When a bond carries no explicit day count, the ledger-models hierarchy gives
the default (LM-498): Treasury notes, Treasury bonds, TIPS and STRIPS use
ACT/ACT ICMA; Treasury bills use ACT/360; corporate and agency bonds use
30/360 US. An explicit value on the bond always wins.

## Sources

- MSRB Rule G-33, Calculations (defines the 30/360 day count used for US
  municipal and corporate bonds):
  https://www.msrb.org/Rules-and-Interpretations/MSRB-Rules/General/Rule-G-33
- US Treasury, 31 CFR Part 356, Appendix B (actual/actual accrued interest
  for Treasury notes and bonds):
  https://www.ecfr.gov/current/title-31/subtitle-B/chapter-II/subchapter-A/part-356
- ICMA Rule 251 and the ISDA 2006 Definitions, section 4.16: cited by name
  only; no text is reproduced here.
- FinTekkers item LM-498: the DayCountConventionProto values and product
  defaults.
