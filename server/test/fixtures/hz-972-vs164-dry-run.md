The three expected values are below. I worked each one out myself from the bond maths library and never opened the repo. For the 1 Mar 2027 cases my figures match the library's worked example: yield 15.2529% and modified duration 2.5790. For the 30 Nov 2026 case there was no published figure, so its number rests only on my own calculation. A reviewer can redo it from the working below.

**Instrument:** CoreWeave 9.25% senior note due 1 June 2030 (ISIN USU2069EAA83).
- Coupon C = 9.25 a year per 100 face, paid twice a year (f = 2) on 1 June and 1 December.
- Redemption R = 100, face 100.
- Day count ACT/ACT ICMA. The coupon schedule uses unadjusted dates.
- Both settlement dates are Mondays and business days on the SIFMA calendar.
- n ≥ 2 in both cases, so the dirty price uses the compound form from section 5. The simple-interest form for the last period does not apply.

**Formulas** (bond-maths sections 2–9). A flow paid at t_k = k + w periods, where k = 0 … n−1, has PV_k = CF_k / (1+y/2)^t_k.
- Accrued: AI = 4.625 · A/E.
- Dirty price: P_dirty = clean + AI. The yield y is solved so that ΣPV_k = P_dirty.
- D_mac = (1/2) · Σ t_k·PV_k / P_dirty.
- D_mod = D_mac / (1 + y/2).
- Convexity = (1/(4·P_dirty)) · Σ t_k(t_k+1)·CF_k/(1+y/2)^(t_k+2).
- DV01 = D_mod · P_dirty · 1e-4.

I solved the yield with Newton–Raphson to a price error below 1e-13.

**Working: settlement 2026-11-30, clean 81.375 (near a coupon date)**
- PCD = 2026-06-01, NCD = 2026-12-01. E = 183, A = 182, DSC = 1.
- w = 1/183 = 0.005464, n = 8.
- AI = 4.625 · 182/183 = 4.599727. P_dirty = 85.974727.
- Per-flow PVs: 4.623002, 4.271540, 3.946798, 3.646744, 3.369502, 3.113337, 2.876647, 60.127157. They sum to 85.974727, within 3e-14 of P_dirty.
- y = 16.455980%. D_mac = 2.854152. **D_mod = 2.637166**.
- Convexity = 9.261096. A ±1bp central difference also gives 9.261096.
- DV01 = 0.022673 per 100, which matches the ±1bp central difference.
- For contrast, the bug (whole periods, solved on the clean price) gives y = 15.6945% and D_mod = 3.1158. That is about 0.48 years too long, so a 0.0005 tolerance catches it.

**Working: settlement 2027-03-01, clean 85.00 (mid-period)**
- PCD = 2026-12-01, NCD = 2027-06-01. E = 182, A = 90, DSC = 92.
- w = 92/182 = 0.505495, n = 7.
- AI = 4.625 · 90/182 = 2.287088. P_dirty = 87.287088.
- Per-flow PVs: 4.456325, 4.140548, 3.847147, 3.574536, 3.321243, 3.085898, 64.861392. They sum to 87.287088, with an error below 1e-13.
- **y = 15.252917%**. D_mac = 2.775694. **D_mod = 2.579007**. Both agree with the worked example to 4 decimals.
- Convexity = 8.577774. The ±1bp central difference gives 8.577775.
- DV01 = 0.022511 per 100, which matches the central difference.
- For contrast, the bug gives y = 14.9047% (35bp low) and D_mod = 2.8158 (0.24 years high).

**Cases**
1. `cw-near-coupon-mod-duration`: modified duration when settlement is one day before a coupon (w = 1/183), at clean 81.375. Source: bond-maths#modified-duration.
2. `cw-mid-period-ytm`: semiannual bond-equivalent yield solved on the dirty price, settling 2027-03-01 at clean 85.00. Source: bond-maths#yield.
3. `cw-mid-period-mod-duration`: modified duration for the same mid-period trade. Source: bond-maths#worked-example, the hand-computed reference D_mod = 2.5790.

The tolerances are 0.0005 percentage points for the yield and 0.0005 years for duration, as success metric 1 sets. Each one is much smaller than the gap the bug produces (0.24 to 0.52 years, or 35bp).

```json golden-cases
{"cases": [
{"id": "cw-near-coupon-mod-duration", "inputs": {"instrument": "CoreWeave 9.25% 2030 USU2069EAA83", "coupon_rate_pct": 9.25, "frequency": 2, "maturity": "2030-06-01", "coupon_months_days": "06-01,12-01", "redemption": 100, "face": 100, "day_count": "ACT/ACT ICMA", "calendar": "SIFMA (settlement Monday, business day)", "settlement": "2026-11-30", "clean_price": 81.375, "pcd": "2026-06-01", "ncd": "2026-12-01", "E_days": 183, "A_days": 182, "DSC_days": 1, "w": 0.005464, "n": 8, "accrued": 4.599727, "dirty_price": 85.974727, "solved_ytm_pct": 16.45598, "macaulay_duration": 2.854152, "convexity": 9.261096, "dv01_per_100": 0.022673}, "measure": "modified_duration_years", "expected": 2.637166, "tolerance": {"abs": 0.0005}, "source": "fintekkers-horizon__farm-projects-fintekkers-knowledge-bond-maths-c8759be5f1#modified-duration"},
{"id": "cw-mid-period-ytm", "inputs": {"instrument": "CoreWeave 9.25% 2030 USU2069EAA83", "coupon_rate_pct": 9.25, "frequency": 2, "maturity": "2030-06-01", "coupon_months_days": "06-01,12-01", "redemption": 100, "face": 100, "day_count": "ACT/ACT ICMA", "calendar": "SIFMA (settlement Monday, business day)", "settlement": "2027-03-01", "clean_price": 85.0, "pcd": "2026-12-01", "ncd": "2027-06-01", "E_days": 182, "A_days": 90, "DSC_days": 92, "w": 0.505495, "n": 7, "accrued": 2.287088, "dirty_price": 87.287088}, "measure": "yield_to_maturity_pct_semiannual_bey", "expected": 15.252917, "tolerance": {"abs": 0.0005}, "source": "fintekkers-horizon__farm-projects-fintekkers-knowledge-bond-maths-c8759be5f1#yield"},
{"id": "cw-mid-period-mod-duration", "inputs": {"instrument": "CoreWeave 9.25% 2030 USU2069EAA83", "coupon_rate_pct": 9.25, "frequency": 2, "maturity": "2030-06-01", "coupon_months_days": "06-01,12-01", "redemption": 100, "face": 100, "day_count": "ACT/ACT ICMA", "calendar": "SIFMA (settlement Monday, business day)", "settlement": "2027-03-01", "clean_price": 85.0, "pcd": "2026-12-01", "ncd": "2027-06-01", "E_days": 182, "A_days": 90, "DSC_days": 92, "w": 0.505495, "n": 7, "accrued": 2.287088, "dirty_price": 87.287088, "solved_ytm_pct": 15.252917, "macaulay_duration": 2.775694, "convexity": 8.577774, "dv01_per_100": 0.022511}, "measure": "modified_duration_years", "expected": 2.579007, "tolerance": {"abs": 0.0005}, "source": "fintekkers-horizon__farm-projects-fintekkers-knowledge-bond-maths-c8759be5f1#worked-example"}
]}
```
