# Settlement and calendars

FinTekkers knowledge library. Written in our own words; the primary sources
are listed at the end. Settlement is the date cash and securities change
hands. It is the date accrued interest, yield and duration are computed at,
so a wrong settlement date is a wrong price.

## 1 Scope {#scope}

US fixed income and US equities traded through FinTekkers: Treasuries, TIPS,
agencies, corporates and listed equities. Other markets need their own
calendar and cycle.

## 2 T+1 {#t-plus-1}

The standard settlement cycle in the US is one business day after the trade
date (T+1). SEC Rule 15c6-1 under the Exchange Act, as amended in 2023,
moved broker-dealer transactions in most securities from T+2 to T+1 with a
compliance date of 28 May 2024. US Treasury securities already settled T+1 by
market practice. A trade may settle on another date only when both sides
agree to it expressly at the time of the trade.

T+1 counts business days, not calendar days: a Friday trade settles on the
following Monday, or later if Monday is a holiday.

## 3 The SIFMA calendar {#sifma-calendar}

Business days for US bond settlement come from the SIFMA recommended holiday
schedule for the US bond market. SIFMA publishes it each year for the
following years. A day is a business day for settlement when it is a weekday
and SIFMA recommends a full close of the bond market on none of it. An early
close (for example 2 pm the day after Thanksgiving) is still a business day.

Equities follow the exchange calendar (NYSE), which differs from SIFMA on
some days: Columbus Day and Veterans Day are bond-market holidays only.

## 4 Holidays {#holidays}

Read holidays from the published calendar for the year, never from a weekday
rule or a list of fixed dates. The usual SIFMA full closes are New Year's
Day, Martin Luther King Jr. Day, Presidents Day, Good Friday (some years an
early close instead), Memorial Day, Juneteenth, Independence Day, Labor Day,
Columbus Day, Veterans Day, Thanksgiving and Christmas. A holiday on a Sunday
is usually observed the next Monday; a Saturday holiday is often not observed
on the Friday. Those are exactly the cases to take from the calendar.

## 5 Business-day adjustment {#business-day-adjustment}

When a scheduled date is not a business day it is moved:

- Following: to the next business day.
- Modified following: to the next business day, unless that is in the next
  month, then to the previous one.
- Preceding: to the previous business day.

For US Treasury and corporate coupons, a payment due on a non-business day is
paid on the next business day with no extra interest. The coupon schedule
used for accrued interest and the period fraction stays on the unadjusted
dates.

## 6 Worked examples {#settlement-examples}

Using the SIFMA 2026 calendar (Thanksgiving is Thursday 26 November 2026):

- Trade Monday 23 Nov 2026: settles Tuesday 24 Nov.
- Trade Wednesday 25 Nov 2026: Thursday is a full close, so it settles
  Friday 27 Nov (an early-close day, still a business day).
- Trade Friday 27 Nov 2026: settles Monday 30 Nov.

## Sources

- SEC, Rule 15c6-1, 17 CFR 240.15c6-1 (standard settlement cycle):
  https://www.ecfr.gov/current/title-17/chapter-II/part-240/section-240.15c6-1
- SEC, Shortening the Securities Transaction Settlement Cycle, final rule,
  release 34-96930 (2023): https://www.sec.gov/rules/final/2023/34-96930.pdf
- SIFMA, US holiday schedule recommendations:
  https://www.sifma.org/resources/general/holiday-schedule/
