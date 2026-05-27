# Aegis algorithms — methods writeup

This document describes the pricing, calibration, settlement, and exposure
algorithms underlying Aegis. Each section names the standard from the
quantitative-finance / actuarial literature it implements and links to the
specific source files.

The mapping is deliberate: every layer of Aegis matches a published industry
standard for the closest analogous asset class (electricity, gas, and other
volatile spot-priced commodities). Compute is the new entry in this class.

---

## 1. Price process — regime-switching mean-reverting jump-diffusion

[`src/pricing/price-model.js`](../src/pricing/price-model.js)

The underlying R (H100-class GPU-hour rental rate, USD/hr) follows a
two-regime mean-reverting jump-diffusion on log price:

```
log R[t+1] = log R[t] + κ(θ − log R[t])·Δt + σ_{s(t)}·√Δt · Z + J_{s(t)}[t]
```

where:

- **κ, θ** — mean reversion speed and long-run log-price (shared across
  regimes; the equilibrium doesn't move, only the variance does)
- **s(t) ∈ {stable, squeeze}** — a continuous-time Markov chain over
  regimes, with daily transition probabilities
  `p_{0→1} = 1 − exp(−λ_{01}·Δt)` derived from annualized rates
- **σ_s** — diffusion volatility in regime s
- **J_s[t]** — fires with probability `λ_s·Δt`; when it fires, drawn from
  N(μ_{J,s}, σ_{J,s}²) with positive mean (upward shortage spikes
  dominate)

### Default parameters

Hand-tuned to real H100 rental history 2023–2025. Calibration cross-checks
in [`src/pricing/calibration.js`](../src/pricing/calibration.js) and
[`src/pricing/em-calibration.js`](../src/pricing/em-calibration.js).

| Regime | σ (per √yr) | λ (jumps/yr) | μ_J | σ_J |
|---|---:|---:|---:|---:|
| Stable  | 0.30 | 1.0  | 0.10 | 0.08 |
| Squeeze | 0.80 | 10.0 | 0.28 | 0.18 |

| Transition rate | Value (per year) | Mean duration |
|---|---:|---:|
| Stable → squeeze | 0.5 | ~2 years between squeezes |
| Squeeze → stable | 4.0 | ~3 months per squeeze |

Stationary squeeze probability ≈ 0.5 / (0.5+4.0) = **11%** of total time.

### Why two regimes

Real H100 rental data shows qualitatively different behavior in shortage
vs. quiet periods — both vol and jump intensity were materially higher
during the 2023-Q3 GPU crunch and the 2024-Q2 Llama-launch squeeze. A
single-regime fit averages those out and either under-prices the tail in
stable times or over-prices it during quiet ones. Regime-switching is the
established remedy for this asset class.

**References**:
[Janczura-Weron 2010](https://www.researchgate.net/publication/23742996_Modeling_electricity_prices_with_regime_switching_models),
[Cartea-Figueroa 2005](https://ideas.repec.org/p/bbk/bbkefp/0507.html),
[Geman-Roncoroni 2006](https://www.researchgate.net/publication/24064906),
[Bégin-Gómez-Ignatieva-Li 2025 (Energy Economics)](https://www.sciencedirect.com/science/article/abs/pii/S0140988321001651).

---

## 2. Monte Carlo with antithetic-pair variance reduction + CVaR risk loading

[`src/pricing/pricer.js`](../src/pricing/pricer.js)

```
premium = expected_payout + risk_load + ops_load
expected_payout = E[ max(0, R_T − K) ] · Q
```

### 2.1 Variance reduction (antithetic variates with best-of-both estimator)

Each Monte Carlo path is paired with its antithetic counterpart: same
uniform / jump-Bernoulli / jump-magnitude / regime-transition draws, but
**sign-flipped diffusion innovations**. For diffusion-dominated payoffs
(at-the-money caps) this drives the variance of the mean estimator down
toward zero; for jump-dominated payoffs (deep OTM) shared jumps inflate
pair-mean variance and plain MC wins.

Aegis computes **both** the plain-MC SE and the antithetic-pair SE every
quote, then uses the tighter one for the CI and the risk load. The result
is **never worse than plain MC**, and 1.5–3× better on diffusion-dominated
payoffs.

The pricer reports:

- `varianceReductionFactor` — ratio (plainSE / bestSE)², always ≥ 1
- `usedEstimator` — 'antithetic' | 'plain'

### 2.2 CVaR-based risk loading (coherent risk measure)

Default risk-load formula:

```
risk_load = α · max(0, CVaR_β(payout) − E[payout])
```

with `α = 0.15`, `β = 0.95`. CVaR_β is the mean of the upper (1−β) tail of
the empirical payout distribution.

**Why CVaR over stdev**: CVaR satisfies the four coherent-risk axioms
(monotonicity, subadditivity, positive homogeneity, translation invariance).
Stdev does **not** satisfy subadditivity — the only coherence axiom that
matters when aggregating portfolio risk. Standard deviation has been
displaced by CVaR/Expected Shortfall as the actuarial standard since
~2000s; Solvency II prescribes ES.

The `stdev` mode (`riskLoadStdevMultiplier · bestSE`) is still selectable
per quote for backward compatibility.

**References**:
[Hardy CAS — Risk Measures for Actuarial Applications](https://www.casact.org/sites/default/files/database/studynotes_hardy4.pdf),
[Wikipedia — Coherent risk measure](https://en.wikipedia.org/wiki/Coherent_risk_measure),
[Variance Reduction in MC Option Pricing 2025 — Dean Francis Press](https://www.deanfrancispress.com/index.php/te/article/view/3316).

### 2.3 Sample quotes (R₀ = $2.50/hr, hbarUsdPrice = $0.05, 20K paths, seed 42)

| Case | Premium | E[payout] | Risk load | Ops load | CVaR_95 | P(ITM) |
|---|---:|---:|---:|---:|---:|---:|
| ATM K=$2.50 30d Q=100 (stable) | 416.7 HBAR | 206.8 | 199.5 | 10.3 | 1536.7 | 48.3% |
| OTM K=$4 30d Q=100 (stable)   | 35.7 HBAR  | 9.2   | 26.1  | 0.5  | 183.0  | 0.3%  |
| OTM K=$6 30d Q=100 (stable)   | 10.9 HBAR  | 2.8   | 8.0   | 0.1  | 56.2   | 0.1%  |
| OTM K=$4 90d Q=100 (stable)   | 444.0 HBAR | 113.8 | 324.4 | 5.7  | 2276.8 | 2.8%  |
| OTM K=$4 30d Q=100 (squeeze)  | 1378.9 HBAR| 471.1 | 884.2 | 23.6 | 6365.7 | 17.5% |

The 38× swing from stable to squeeze for the same K = $4 OTM cap is
exactly the regime-aware signal — buying protection during a known
shortage is appropriately expensive.

---

## 3. Calibration — Press-Ball-Torous EM

[`src/pricing/em-calibration.js`](../src/pricing/em-calibration.js),
[`src/pricing/calibration.js`](../src/pricing/calibration.js)

### 3.1 Method-of-moments (the seed)

For each monthly log-return r_t:
- Identify "jumps" as any observation with r_t > μ + 2σ
- Estimate σ from std of non-jump returns, annualized × √12
- Estimate λ from jump frequency
- Estimate (μ_J, σ_J) from jump returns

Simple, robust, but the 2σ threshold is brittle on small datasets.

### 3.2 EM (the upgrade)

The latent variable is `I_t ∈ {0, 1}` per observation — did a jump fire?
Each return is a mixture:

```
r_t | I=0 ~ N( μ_t, σ²·Δt )                        (diffusion-only)
r_t | I=1 ~ N( μ_t + μ_J, σ²·Δt + σ_J² )           (diffusion + jump)
```

where `μ_t = κ(θ − log P_{t−1})·Δt` is the local OU drift (κ, θ held
fixed at the method-of-moments seed). The EM algorithm iterates:

- **E-step**: compute the posterior probability `γ_t = P(I_t = 1 | r_t, θ̂)`
- **M-step**: weighted MLE for (σ², λ, μ_J, σ_J²) using γ as weights

By the Dempster-Laird-Rubin EM theorem the marginal log-likelihood is
monotonically non-decreasing; convergence to a local maximum is
guaranteed. On the bundled H100 dataset, EM converges in **22 iterations**.

### 3.3 Calibration output on the bundled 36-month H100 series

| Method | κ | σ | λ | μ_J | σ_J | jumps identified |
|---|---:|---:|---:|---:|---:|---:|
| Method-of-moments | 0.291 | 0.228 | 0.686 | 0.171 | 0.001 | 2 (>2σ threshold) |
| EM (Press-Ball-Torous) | 0.291 | 0.167 | 2.021 | 0.149 | 0.0001 | 4 (P>0.5 posterior) |

EM identifies **all annotated shock months** in the top of the posterior
ranking:

| Month | EM posterior P(jump) |
|---|---:|
| 2023-07 (shortage onset, annotated) | 0.995 |
| 2023-06 (lead-up) | 0.995 |
| 2024-04 (Llama 3 squeeze, annotated) | 0.960 |
| 2023-08 (shortage, annotated) | 0.941 |
| 2023-05 (lead-up) | 0.928 |

Both calibrations are exposed via the kit tool `aegis_get_price_params`
for runtime audit; runtime uses hand-tuned `DEFAULT_REGIME_PARAMS`
(documented in [`src/pricing/price-model.js`](../src/pricing/price-model.js)).

Known limitation: EM degenerates the σ_J estimate to ~zero on small
datasets where the identified jumps are tightly clustered in magnitude.
Documented in code; mitigation in [`LIMITATIONS.md`](../LIMITATIONS.md).

**References**:
[Press 1967 — Compound events models](https://www.jstor.org/stable/2350917),
Ball-Torous 1983 (jump-diffusion mixture),
[ESAIM PS 2020 — Monte-Carlo EM for jump-diffusions](https://www.esaim-ps.org/articles/ps/pdf/2020/01/ps190083.pdf),
[arXiv 2211.17220 — MLE for Markov-Modulated Jump-Diffusion](https://arxiv.org/abs/2211.17220).

---

## 4. Settlement — Asian-style trailing TWAP

[`src/server/app.js`](../src/server/app.js) (`ASIAN_SETTLEMENT_WINDOW_DAYS = 7`),
[`src/agents/underwriter.js`](../src/agents/underwriter.js),
[`src/hedera/envelope.js`](../src/hedera/envelope.js)

The settlement R observed by the policy is the **arithmetic mean of R
over the last 7 days of the coverage window** — not a single observation
at expiry. The SETTLEMENT envelope records `observationWindowDays` so the
audit trail makes the averaging explicit.

**Why Asian**: single-point settlement is vulnerable to manipulation —
a one-day price spike on the expiry day fires the cap fully. Averaging
over a 7-day window dampens this: a spike on the final day contributes
only ~14% to the settlement. Modern commodity-derivatives markets all
use averaging-window settlement for this reason; the construction is
classical.

Trade-off: longer averaging windows reduce manipulation risk but also
reduce the cap's responsiveness to a real spike near expiry. 7 days is
the standard for monthly-window contracts in commodities; longer for
quarterly contracts.

**References**:
[Moontower — Asian options & manipulation protection](https://blog.moontower.ai/asian-options/),
[Deribit settlement (30-min TWAP)](https://support.deribit.com/hc/en-us/articles/29734325712413-Settlement),
CME and ICE commodity contracts.

---

## 5. Exposure — joint-payout 99% VaR

[`src/pool/exposure.js`](../src/pool/exposure.js) (`checkIssuanceJointVaR`),
[`src/pricing/pricer.js`](../src/pricing/pricer.js) (`sampleStressedRT`)

Pool-cap acceptance for new policies uses the **99% Value-at-Risk of the
joint payout distribution over all active and proposed policies**, rather
than the Σ-maxPayout upper bound the original spec described.

### 5.1 The comonotone observation

All Aegis caps pay against the same underlying R. So the joint payout is
**comonotone** in R: as R rises, every policy's payout rises or stays
flat. The maximum aggregate payout (Σ-maxPayout) is the comonotone upper
bound — tight only when all policies fire at the same R.

For homogeneous-strike portfolios this means joint-VaR = Σ-maxPayout.
For heterogeneous-strike portfolios (different K's) the joint q-quantile
is **below** Σ-maxPayout — because at the q-quantile R, some policies
fire and others don't. The pool can underwrite more notional without
raising default risk above its target.

### 5.2 Stress-regime sampling

R_T samples come from `sampleStressedRT` — antithetic-paired terminal-R
draws from the **squeeze-pinned regime** (`initialSqueezeProb = 1`). This
is conservative: we ask "what's the joint payout if the squeeze regime is
active the entire window?" — which is precisely the tail scenario the
pool must remain solvent through.

### 5.3 Acceptance criterion

Policy is acceptable iff:

```
quantile_99(joint_payout_hbar) ≤ pool_balance · max_exposure_ratio
```

with `max_exposure_ratio = 0.5` by default. This is the Solvency-II-style
99% VaR over a one-window holding period.

**References**:
Solvency II Pillar 1 (VaR-99.5% over one-year),
[Han et al. 2024 — Risk Concentration and Mean-ES Criterion](https://onlinelibrary.wiley.com/doi/abs/10.1111/mafi.12417),
[Hardy CAS — Risk Measures for Actuarial Applications](https://www.casact.org/sites/default/files/database/studynotes_hardy4.pdf).

---

## 6. Trust boundary (what stays cryptographic vs. statistical)

Worth surfacing explicitly because it intersects with the algorithm choices:

| Quantity | Source | Verifiable how |
|---|---|---|
| Premium transfer (buyer → underwriter) | On-chain HBAR transfer | Mirror node REST API, `matchesExpectedTransfer` (seller credit exact, buyer debit ≥ amount + fee) |
| Payout transfer (underwriter → buyer) | On-chain HBAR transfer | Same |
| POLICY / PRICE_REF / SETTLEMENT records | HCS topic | Read via mirror node REST; **index only**, not proof |
| R(t) used for settlement | Local simulator, labeled | `source: sim:labeled` / `sim:shock` enforced by envelope schema |

The algorithm upgrades above all touch what we *do* with the on-chain
data (price modeling, exposure, settlement math); they don't change which
quantities are trust-rooted in the ledger vs. which are statistical. See
[`LIMITATIONS.md`](../LIMITATIONS.md) for the full disclosure.

---

## 7. Future work

- **Stochastic volatility** (Heston-style — variance is its own mean-reverting
  process) on top of regime-switching. The current regime model approximates
  this with two discrete states; a continuous variance process is the more
  expressive form.
- **Lévy-driven SDE generalization** of the jump distribution (currently
  Gaussian jumps; CGMY / variance-gamma processes are more flexible at the
  cost of complexity).
- **Multi-asset CVaR aggregation** if Aegis ever supports A100, H200, B100,
  etc. caps — the joint-VaR machinery generalizes; we'd need a copula for
  cross-class dependence.
- **EM with Baum-Welch over the regime sequence** — the natural extension
  of the current single-regime EM, would let us calibrate regimes from
  data rather than hand-tune.
- **Wang-transform pricing** ([Wang 2002 CAS](https://www.casact.org/sites/default/files/old/astin_wang.pdf))
  as an alternative to CVaR loading — distortion-based premium principle
  with a market price of risk parameter.
- **Real GPU price feed** when one becomes API-available. The
  envelope schema (`source: calibration:<dataset-id>`) is already shaped
  for it.
