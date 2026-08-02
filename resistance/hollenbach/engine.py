# resistance/hollenbach/engine.py
import math
import numpy as np

try:
    from numba import njit
    NUMBA_AVAILABLE = True
except Exception:
    NUMBA_AVAILABLE = False

    def njit(*dargs, **dkwargs):
        if dargs and callable(dargs[0]) and len(dargs) == 1 and not dkwargs:
            return dargs[0]
        def wrapper(func):
            return func
        return wrapper


# ──────────────────────────────────────────────────────────────────
# Appendage 1+k2 form factors (Holtrop & Mennen catalogue)
# ──────────────────────────────────────────────────────────────────
APPENDAGE_K2 = {
    'behind_skeg':  1.5,
    'behind_stern': 1.3,
    'twin':         2.8,
    'keel':         1.4,
    'shaft':        2.0,
    'strut':        3.0,
    'bracket':      3.0,
    'fin':          2.8,
    'dome':         2.7,
    'hull':         2.0,
}

APPENDAGE_NAMES = tuple(APPENDAGE_K2.keys())


def build_appendage_totals(ship_data: dict):
    """
    Scan ship_data for appendage keys and return:
      - total_sapp  : total appendage wetted area  (m²)
      - k2_eff      : area-weighted effective 1+k2 factor
    """
    total_area  = 0.0
    weighted_k2 = 0.0

    for name in APPENDAGE_NAMES:
        area_key = name + '_area'
        k2_val   = float(ship_data.get(name, 0.0))
        area_val = float(ship_data.get(area_key, 0.0))

        if k2_val <= 0.0 or area_val <= 0.0:
            continue

        total_area  += area_val
        weighted_k2 += k2_val * area_val

    if total_area > 0.0:
        k2_eff = weighted_k2 / total_area
    else:
        k2_eff = 0.0

    return total_area, k2_eff


@njit(cache=True, fastmath=True)
def _hollenbach_core(
    LPP, LWL, LOS, B, T, V_disp, AVS, dTH, D, Ta, Tf, CDA,
    SAPP_mean, SAPP_min, k2_eff,
    VS,          # 1-D array of speeds in m/s
):
    """
    Numba-accelerated Hollenbach resistance calculation.

    Returns
    -------
    RTm      : mean total resistance (N) — same length as VS
    RTmin    : min total resistance (N)
    R_fric_m : bare-hull friction (N)
    R_wave_m : bare-hull wave/residuary (N)
    R_app_m  : appendage resistance mean (N)
    R_app_min: appendage resistance min (N)
    CB       : block coefficient (scalar)
    Sd       : wetted surface (scalar)
    """
    # ── Constants ─────────────────────────────────────────────────
    g      = 9.807
    rho    = 1026.021
    nu     = 1.1892e-6
    rhoair = 1.225

    n = VS.shape[0]

    # ── Geometry ──────────────────────────────────────────────────
    CB = V_disp / (B * T * LPP)

    if LOS < LPP:
        LC = LOS
    elif LOS > 1.1 * LPP:
        LC = 1.0667 * LPP
    else:
        LC = LPP + (2.0 / 3.0) * (LOS - LPP)

    # ── Wetted surface ────────────────────────────────────────────
    S0d = -0.6837;  S1d = 0.2771;  S2d = 0.6542;  S3d = 0.6422
    S4d =  0.0075;  S5d = 0.0275;  S6d = -0.0045; S7d = -0.4798
    S8d =  0.0376

    kd = (S0d + S1d*(LOS/LWL) + S2d*(LWL/LPP) + S3d*CB
          + S4d*(LPP/B) + S5d*(B/T) + S6d*(LPP/T)
          + S7d*((Ta - Tf)/LPP) + S8d*(D/T))
    Sd = kd * LPP * (B + 2.0*T)

    # ── Regression coefficients ───────────────────────────────────
    b12dm  = 13.3893;  b13dm  = 90.596
    b21dm  = 4.6614;   b22dm  = -39.721;  b23dm  = -351.483
    b31dm  = -1.14215; b32dm  = -12.3296; b33dm  = 459.254

    b12dmin = 13.3893;  b13dmin = 90.596
    b21dmin = 4.6614;   b22dmin = -39.721;  b23dmin = -351.483
    b31dmin = -1.14215; b32dmin = -12.3296; b33dmin = 459.254

    if CB < 0.49:
        b11drr = 0.49
    elif CB > 0.6:
        b11drr = -0.57424
    else:
        b11drr = -0.57424 - 25.0 * ((0.06 - CB) ** 2)

    # ── Mean coefficients ─────────────────────────────────────────
    a1dm = 0.3382;  a2dm = -0.8086; a3dm = -6.0258
    a4dm = -3.5632; a5dm = 9.4405;  a6dm = 0.0146
    d1dm = 0.854;   d2dm = -1.228;  d3dm = 0.497
    e1dm = 2.1701;  e2dm = -0.1602

    # ── Min coefficients ──────────────────────────────────────────
    a1dmin = 0.3382;  a2dmin = -0.8086; a3dmin = -6.0258
    a4dmin = -3.5632; a5dmin = 0.0;     a6dmin = 0.0

    # ── k-factors (speed-independent) ─────────────────────────────
    BT_ratio  = B / T
    LB_ratio  = LPP / B
    LL_ratio  = LOS / LWL
    AO_ratio  = LWL / LPP
    DTA_ratio = D / Ta

    Frcrit = d1dm + d2dm*CB + d3dm*CB*CB
    kLm    = e1dm * LPP**e2dm

    kBTm   = 1.99**a1dm   if BT_ratio < 1.99  else BT_ratio**a1dm
    kLBm   = LB_ratio**a2dm if LB_ratio <= 7.11 else 7.11**a2dm
    kLLm   = LL_ratio**a3dm if LL_ratio <= 1.05 else 1.05**a3dm
    kAOm   = AO_ratio**a4dm if AO_ratio <= 1.06 else 1.06**a4dm
    kTrm   = (1.0 + (Ta - Tf) / LPP)**a5dm

    if   DTA_ratio < 0.43: kPrm = 0.43**a6dm
    elif DTA_ratio > 0.84: kPrm = 0.84
    else:                  kPrm = DTA_ratio**a6dm

    kBTmin = 1.99**a1dmin   if BT_ratio < 1.99  else BT_ratio**a1dmin
    kLBmin = LB_ratio**a2dmin if LB_ratio <= 7.11 else 7.11**a2dmin
    kLLmin = LL_ratio**a3dmin if LL_ratio <= 1.05 else 1.05**a3dmin
    kAOmin = AO_ratio**a4dmin if AO_ratio <= 1.06 else 1.06**a4dmin
    kTrmin = (1.0 + (Ta - Tf) / LPP)**a5dmin

    if   DTA_ratio < 0.43: kPrmin = 0.43**a6dmin
    elif DTA_ratio > 0.84: kPrmin = 0.84
    else:                  kPrmin = DTA_ratio**a6dmin

    CAm   = (0.35 - 0.002*LPP)*0.001 if LPP < 175.0 else 0.0
    CAmin = (0.35 - 0.002*LPP)*0.001 if LPP < 175.0 else 0.0

    CAASm   = CDA * (rhoair * AVS) / (rho * Sd)
    CAASmin = CAASm

    CDTHm   = 0.003 + 0.003*(10.0*dTH/T - 1.0)
    CDTHmin = CDTHm

    inv_Sd_10 = B * T / (10.0 * Sd)

    # ── Output arrays ─────────────────────────────────────────────
    RTm       = np.empty(n, dtype=np.float64)
    RTmin_arr = np.empty(n, dtype=np.float64)
    R_fric_m  = np.empty(n, dtype=np.float64)
    R_wave_m  = np.empty(n, dtype=np.float64)
    R_app_m   = np.empty(n, dtype=np.float64)
    R_app_mn  = np.empty(n, dtype=np.float64)

    for i in range(n):
        v   = VS[i]
        v2  = v * v
        qS  = 0.5 * rho * v2 * Sd     # dynamic pressure × Sd
        q   = 0.5 * rho * v2          # dynamic pressure

        Re  = v * LC / nu
        FN  = v / math.sqrt(g * LC)

        log10Re = math.log10(Re) if Re > 1.0 else 0.0
        CF  = 0.075 / ((log10Re - 2.0) ** 2)

        FN2 = FN * FN

        # ── MEAN ──────────────────────────────────────────────────
        if FN >= Frcrit:
            c1dm   = FN / Frcrit
            kFrm_i = (FN / Frcrit) ** c1dm
        else:
            kFrm_i = 1.0

        CRstdm = (b11drr + b12dm*FN + b13dm*FN2
                  + (b21dm + b22dm*FN + b23dm*FN2)*CB
                  + (b31dm + b32dm*FN + b33dm*FN2)*CB*CB)
        CRBTm  = CRstdm * kFrm_i * kLm * kBTm * kLBm * kLLm * kAOm * kTrm * kPrm
        CRm    = 1000.0 * CRBTm * inv_Sd_10

        R_app_i  = q * SAPP_mean * k2_eff * CF
        RTH_i    = rho * v2 * math.pi * (dTH*dTH) * CDTHm
        CAPP_i   = (R_app_i + RTH_i) / qS if qS > 1e-30 else 0.0

        CT_i = CF + CRm + CAm + CAPP_i + CAASm
        RTm[i]      = qS * CT_i
        R_fric_m[i] = qS * CF
        R_wave_m[i] = qS * CRm
        R_app_m[i]  = R_app_i

        # ── MIN ───────────────────────────────────────────────────
        CRstdmin = (b11drr + b12dmin*FN + b13dmin*FN2
                    + (b21dmin + b22dmin*FN + b23dmin*FN2)*CB
                    + (b31dmin + b32dmin*FN + b33dmin*FN2)*CB*CB)
        CRBTmin  = CRstdmin * kBTmin * kLBmin * kLLmin * kAOmin * kTrmin * kPrmin
        CRmin_i  = 1000.0 * CRBTmin * inv_Sd_10

        R_app_min_i = q * SAPP_min * k2_eff * CF
        RTH_min_i   = rho * v2 * math.pi * (dTH*dTH) * CDTHmin
        CAPP_min_i  = (R_app_min_i + RTH_min_i) / qS if qS > 1e-30 else 0.0

        CT_min_i = CF + CRmin_i + CAmin + CAPP_min_i + CAASmin
        RTmin_arr[i] = qS * CT_min_i
        R_app_mn[i]  = R_app_min_i

    return RTm, RTmin_arr, R_fric_m, R_wave_m, R_app_m, R_app_mn, CB, Sd


def calculate_hollenbach_resistance(ship_data: dict) -> dict:
    """
    High-level wrapper — validates inputs, calls the Numba core,
    returns a JSON-ready dict.
    """
    # ── Extract principal dimensions ──────────────────────────────
    LPP    = float(ship_data['LPP'])
    LWL    = float(ship_data['LWL'])
    LOS    = float(ship_data['LOS'])
    B      = float(ship_data['B'])
    T      = float(ship_data['T'])
    V_disp = float(ship_data['V'])
    AVS    = float(ship_data['AVS'])
    dTH    = float(ship_data['dTH'])
    D      = float(ship_data['D'])
    Ta     = float(ship_data.get('Ta', T))
    Tf     = float(ship_data.get('Tf', T))
    CDA    = float(ship_data.get('CDA', 0.8))
    Vl     = float(ship_data['Vl'])
    Vh     = float(ship_data['Vh'])

    # ── Appendage parameters ─────────────────────────────────────
    app_area_individual, k2_individual = build_appendage_totals(ship_data)
    legacy_sapp = float(ship_data.get('SAPP', 0))
    legacy_k2i  = float(ship_data.get('k2i', 0.4))

    if app_area_individual > 0:
        SAPP_override = app_area_individual
        k2_eff        = k2_individual
    elif legacy_sapp > 0:
        SAPP_override = legacy_sapp
        k2_eff        = legacy_k2i
    else:
        SAPP_override = 0.0
        k2_eff        = legacy_k2i

    # ── Wetted surface (quick pre-calc for fallback SAPP) ─────────
    CB = V_disp / (B * T * LPP)

    S0d = -0.6837; S1d = 0.2771; S2d = 0.6542; S3d = 0.6422
    S4d = 0.0075;  S5d = 0.0275; S6d = -0.0045; S7d = -0.4798
    S8d = 0.0376

    kd = (S0d + S1d*(LOS/LWL) + S2d*(LWL/LPP) + S3d*CB
          + S4d*(LPP/B) + S5d*(B/T) + S6d*(LPP/T)
          + S7d*((Ta - Tf)/LPP) + S8d*(D/T))
    Sd = kd * LPP * (B + 2.0*T)

    if SAPP_override > 0:
        SAPPm   = SAPP_override
        SAPPmin = SAPP_override
    else:
        SAPPmin = Sd * (0.0280 + 0.010 ** (-1.0 * ((LPP*T)/1000.0)) * Sd)
        SAPPm   = Sd * (0.0325 + 0.045 ** (-((LPP*T)/1000.0)))

    # ── Speed array ───────────────────────────────────────────────
    num_speeds = max(int((Vh - Vl) * 2 + 1), 2)
    Vskn = np.linspace(Vl, Vh, num=num_speeds)
    VS   = Vskn * (1852.0 / 3600.0)

    # ── Call core ─────────────────────────────────────────────────
    (RTm, RTmin, R_fric_m, R_wave_m,
     R_app_m, R_app_min, CB_out, Sd_out) = _hollenbach_core(
        LPP, LWL, LOS, B, T, V_disp, AVS, dTH, D, Ta, Tf, CDA,
        SAPPm, SAPPmin, k2_eff,
        VS,
    )

    return {
        'speeds_knots':       Vskn.tolist(),
        'speeds_ms':          VS.tolist(),

        'RT_mean_N':          RTm.tolist(),
        'RT_min_N':           RTmin.tolist(),
        'RT_mean_kN':         (RTm   / 1000.0).tolist(),
        'RT_min_kN':          (RTmin / 1000.0).tolist(),

        'R_friction_mean_N':  R_fric_m.tolist(),
        'R_wave_mean_N':      R_wave_m.tolist(),
        'R_appendage_mean_N': R_app_m.tolist(),
        'R_appendage_min_N':  R_app_min.tolist(),

        'CB':                 float(CB_out),
        'Wetted_Surface_Sd':  float(Sd_out),
        'appendage_area':     float(SAPPm),
        'k2_effective':       float(k2_eff),
    }


def check_hollenbach_permissible(ship_data: dict) -> list:
    """Validates principal dimensions against Hollenbach regression limits."""
    LPP = float(ship_data['LPP'])
    B   = float(ship_data['B'])
    T   = float(ship_data['T'])
    D   = float(ship_data['D'])
    V   = float(ship_data['V'])
    CB  = V / (B * T * LPP)

    errors = []
    if not (42   <= LPP        <= 205 ): errors.append(f"LPP outside range 42–205 m: {LPP}")
    if not (4.71 <= LPP/B      <= 7.11): errors.append(f"LPP/B outside range 4.71–7.11: {LPP/B:.2f}")
    if not (1.99 <= B/T        <= 4.00): errors.append(f"B/T outside range 1.99–4.00: {B/T:.2f}")
    if not (0.43 <= D/T        <= 0.84): errors.append(f"Prop D/T outside range 0.43–0.84: {D/T:.2f}")
    if not (0.60 <= CB         <= 0.83): errors.append(f"CB outside range 0.60–0.83: {CB:.2f}")

    L_D = LPP / (V ** (1.0/3.0))
    if not (4.49 <= L_D <= 6.01): errors.append(f"L/∇^(1/3) outside range 4.49–6.01: {L_D:.2f}")

    return errors


def warmup_numba():
    """Call at app startup to pre-compile the Numba kernel."""
    if not NUMBA_AVAILABLE:
        return
    VS = np.array([5.0, 10.0], dtype=np.float64)
    _hollenbach_core(
        160.0, 165.0, 170.0, 24.0, 9.0, 25000.0,
        500.0, 1.0, 6.0, 9.0, 9.0, 0.8,
        50.0, 40.0, 1.5,
        VS,
    )