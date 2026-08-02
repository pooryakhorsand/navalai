# maneuver/B/engine.py
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


# ============================================================
# Wageningen B-Series polynomial coefficients
# Row: [C_Kq, s, t, u, v,   C_Kt, p, q, r, s]
# ============================================================
BSERIES_COEFFS = [
    [0.00379368,  0, 0, 0, 0,   0.00880496,  0, 0, 0, 0],
    [0.00886523,  2, 0, 0, 0,  -0.204554,    1, 0, 0, 0],
    [-0.032241,   1, 1, 0, 0,   0.166351,    0, 1, 0, 0],
    [0.00344778,  0, 2, 0, 0,   0.158114,    0, 2, 0, 0],
    [-0.0408811,  0, 1, 1, 0,  -0.147581,    2, 0, 1, 0],
    [-0.108009,   1, 1, 1, 0,  -0.481497,    1, 1, 1, 0],
    [-0.0885381,  2, 1, 1, 0,   0.415437,    0, 2, 1, 0],
    [0.188561,    0, 2, 1, 0,   0.0144043,   0, 0, 0, 1],
    [-0.00370871, 1, 0, 0, 1,  -0.0530054,   2, 0, 0, 1],
    [0.00513696,  0, 1, 0, 1,   0.0143481,   0, 1, 0, 1],
    [0.0209449,   1, 1, 0, 1,   0.0606826,   1, 1, 0, 1],
    [0.00474319,  2, 1, 0, 1,  -0.0125894,   0, 0, 1, 1],
    [-0.00723408, 2, 0, 1, 1,   0.0109689,   1, 0, 1, 1],
    [0.00438388,  1, 1, 1, 1,  -0.133698,    0, 3, 0, 0],
    [-0.0269403,  0, 2, 1, 1,   0.00638407,  0, 6, 0, 0],
    [0.0558082,   3, 0, 1, 0,  -0.00132718,  2, 6, 0, 0],
    [0.0161886,   0, 3, 1, 0,   0.168496,    3, 0, 1, 0],
    [0.00318086,  1, 3, 1, 0,  -0.0507214,   0, 0, 2, 0],
    [0.015896,    0, 0, 2, 0,   0.0854559,   2, 0, 2, 0],
    [0.0471729,   1, 0, 2, 0,  -0.0504475,   3, 0, 2, 0],
    [0.0196283,   3, 0, 2, 0,   0.010465,    1, 6, 2, 0],
    [-0.0502782,  0, 1, 2, 0,  -0.00648272,  2, 6, 2, 0],
    [-0.030055,   3, 1, 2, 0,  -0.00841728,  0, 3, 0, 1],
    [0.0417122,   2, 2, 2, 0,   0.0168424,   1, 3, 0, 1],
    [-0.0397722,  0, 3, 2, 0,  -0.00102296,  3, 3, 0, 1],
    [-0.00350024, 0, 6, 2, 0,  -0.0317791,   0, 3, 1, 1],
    [-0.0106854,  3, 0, 0, 1,   0.018604,    1, 0, 2, 1],
    [0.00110903,  3, 3, 0, 1,  -0.00410798,  0, 2, 2, 1],
    [-0.000313912,0, 6, 0, 1,  -0.000606848, 0, 0, 0, 2],
    [0.0035985,   3, 0, 1, 1,  -0.0049819,   1, 0, 0, 2],
    [-0.00142121, 0, 6, 1, 1,   0.0025983,   2, 0, 0, 2],
    [-0.00383637, 1, 0, 2, 1,  -0.000560528, 3, 0, 0, 2],
    [0.0126803,   0, 2, 2, 1,  -0.00163652,  1, 2, 0, 2],
    [-0.00318278, 2, 3, 2, 1,  -0.000328787, 1, 6, 0, 2],
    [0.00334268,  0, 6, 2, 1,   0.000116502, 2, 6, 0, 2],
    [-0.00183491, 1, 1, 0, 2,   0.000690904, 0, 0, 1, 2],
    [0.000112451, 3, 2, 0, 2,   0.00421749,  0, 3, 1, 2],
    [-0.0000297228,3,6, 0, 2,   0.0000565229,3, 6, 1, 2],
    [0.000269551, 1, 0, 1, 2,  -0.00146564,  0, 3, 2, 2],
    [0.00083265,  2, 0, 1, 2,   0.0,         0, 0, 0, 0],
    [0.00155334,  0, 2, 1, 2,   0.0,         0, 0, 0, 0],
    [0.000302683, 0, 6, 1, 2,   0.0,         0, 0, 0, 0],
    [-0.0001843,  0, 0, 2, 2,   0.0,         0, 0, 0, 0],
    [-0.000425399,0, 3, 2, 2,   0.0,         0, 0, 0, 0],
    [0.0000869243,3, 3, 2, 2,   0.0,         0, 0, 0, 0],
    [-0.0004689,  0, 6, 2, 2,   0.0,         0, 0, 0, 0],
    [0.0000554194,1, 6, 2, 2,   0.0,         0, 0, 0, 0],
]

# Pre-split into typed arrays once at import time (numba-friendly).
_C = np.asarray(BSERIES_COEFFS, dtype=np.float64)

_KQ_C = np.ascontiguousarray(_C[:, 0])
_KQ_S = np.ascontiguousarray(_C[:, 1].astype(np.int64))
_KQ_T = np.ascontiguousarray(_C[:, 2].astype(np.int64))
_KQ_U = np.ascontiguousarray(_C[:, 3].astype(np.int64))
_KQ_V = np.ascontiguousarray(_C[:, 4].astype(np.int64))

_KT_C = np.ascontiguousarray(_C[:, 5])
_KT_P = np.ascontiguousarray(_C[:, 6].astype(np.int64))
_KT_Q = np.ascontiguousarray(_C[:, 7].astype(np.int64))
_KT_R = np.ascontiguousarray(_C[:, 8].astype(np.int64))
_KT_S = np.ascontiguousarray(_C[:, 9].astype(np.int64))

_TWO_PI = 2.0 * np.pi


@njit(cache=True, fastmath=True)
def _bseries_core(
    J_array,
    pd_values,
    EAR,
    Z,
    Re,
    kt_C, kt_p, kt_q, kt_r, kt_s,
    kq_C, kq_s, kq_t, kq_u, kq_v,
):
    nP = pd_values.shape[0]
    nJ = J_array.shape[0]
    n_terms = kt_C.shape[0]

    Kt_out = np.empty((nP, nJ), dtype=np.float64)
    Kq_out = np.empty((nP, nJ), dtype=np.float64)
    Kq10_out = np.empty((nP, nJ), dtype=np.float64)
    eta_out = np.empty((nP, nJ), dtype=np.float64)

    apply_re = Re > 2_000_000.0
    log_re = 0.0
    if apply_re:
        log_re = np.log10(Re) - 0.301

    log_re2 = log_re * log_re
    Zf = float(Z)

    # optimum tracking
    best_eta = -1.0
    best_J = 0.0
    best_PoD = pd_values[0]
    best_Kt = 0.0
    best_Kq = 0.0

    for ip in range(nP):
        PoD = pd_values[ip]

        for ij in range(nJ):
            J = J_array[ij]

            kt_sum = 0.0
            kq_sum = 0.0
            for k in range(n_terms):
                kt_sum += (
                    kt_C[k]
                    * J ** kt_p[k]
                    * PoD ** kt_q[k]
                    * EAR ** kt_r[k]
                    * Zf ** kt_s[k]
                )
                kq_sum += (
                    kq_C[k]
                    * J ** kq_s[k]
                    * PoD ** kq_t[k]
                    * EAR ** kq_u[k]
                    * Zf ** kq_v[k]
                )

            dKt = 0.0
            dKq = 0.0
            if apply_re:
                J2 = J * J
                PoD2 = PoD * PoD
                PoD3 = PoD2 * PoD
                PoD6 = PoD3 * PoD3
                EAR2 = EAR * EAR

                dKt = (
                    -0.000353485
                    - 0.00333758 * EAR * J2
                    - 0.00478125 * EAR * PoD * J
                    + 0.000257792 * log_re2 * EAR * J2
                    + 0.0000643192 * log_re * PoD6 * J2
                    - 0.0000110636 * log_re2 * PoD6 * J2
                    - 0.0000276305 * log_re2 * Zf * EAR * J2
                    + 0.00009545 * log_re * Zf * EAR * PoD * J
                    + 0.0000032049 * log_re * Zf * Zf * EAR * PoD3 * J
                )

                dKq = (
                    -0.000561412
                    + 0.00696898 * PoD
                    - 0.0000666654 * Zf * PoD6
                    + 0.0160818 * EAR2
                    - 0.000938091 * log_re * PoD
                    - 0.00059593 * log_re * PoD2
                    + 0.0000782099 * log_re2 * PoD2
                    + 0.0000052199 * log_re * Zf * EAR * J2
                    - 0.00000088528 * log_re2 * Zf * EAR * PoD * J
                    + 0.0000230171 * log_re * Zf * PoD6
                    - 0.0000184341 * log_re2 * Zf * PoD6
                    - 0.00400252 * log_re * EAR2
                    + 0.000220915 * log_re2 * EAR2
                )

            Kt = kt_sum + dKt
            if Kt < 0.0:
                Kt = 0.0

            Kq = kq_sum + dKq

            if Kq > 1e-9:
                eta = (J * Kt) / (_TWO_PI * Kq)
            else:
                eta = 0.0

            if eta < 0.0:
                eta = 0.0
            elif eta > 1.0:
                eta = 1.0

            Kt_out[ip, ij] = Kt
            Kq_out[ip, ij] = Kq
            Kq10_out[ip, ij] = Kq * 10.0
            eta_out[ip, ij] = eta

            # optimum heuristic (cap at 0.88, matches frontend)
            if 0.0 < eta <= 0.88 and eta > best_eta:
                best_eta = eta
                best_J = J
                best_PoD = PoD
                best_Kt = Kt
                best_Kq = Kq

    return (
        Kt_out, Kq_out, Kq10_out, eta_out,
        best_J, best_PoD, best_Kt, best_Kq, best_eta,
    )


class WageningenBSeriesModel:
    """
    Wageningen B-Series open-water propeller performance solver.
    Numba-accelerated batch sweep over (P/D, J).
    """

    def __init__(self, Z, EAR, PD_min, PD_max, Re=2_000_000,
                 J_steps=51, PD_step=0.15):
        self.Z = int(Z)
        self.EAR = float(EAR)
        self.PD_min = float(PD_min)
        self.PD_max = float(PD_max)
        self.Re = float(Re)
        self.J_steps = int(J_steps)
        self.PD_step = float(PD_step)

    def _pd_values(self):
        vals = []
        p = self.PD_min
        while p <= self.PD_max + 1e-9:
            vals.append(round(p, 4))
            p += self.PD_step
        if not vals:
            vals = [self.PD_min]
        return np.asarray(vals, dtype=np.float64)

    def sweep(self):
        J_array = np.linspace(0.0, 1.6, self.J_steps)
        pd_values = self._pd_values()

        (
            Kt_out, Kq_out, Kq10_out, eta_out,
            best_J, best_PoD, best_Kt, best_Kq, best_eta,
        ) = _bseries_core(
            J_array,
            pd_values,
            self.EAR,
            self.Z,
            self.Re,
            _KT_C, _KT_P, _KT_Q, _KT_R, _KT_S,
            _KQ_C, _KQ_S, _KQ_T, _KQ_U, _KQ_V,
        )

        if best_eta < 0.0:
            optimum = {
                "J": 0.0, "PoD": float(pd_values[0]),
                "Kt": 0.0, "Kq": 0.0, "eta": 0.0,
            }
        else:
            optimum = {
                "J": float(best_J),
                "PoD": float(best_PoD),
                "Kt": float(best_Kt),
                "Kq": float(best_Kq),
                "eta": float(best_eta),
            }

        return {
            "J_array": J_array,
            "pd_values": pd_values,
            "Kt": Kt_out,
            "Kq": Kq_out,
            "Kq10": Kq10_out,
            "eta": eta_out,
            "optimum": optimum,
        }


def warmup_numba():
    """Trigger JIT compilation once at startup to avoid first-request latency."""
    if not NUMBA_AVAILABLE:
        return

    model = WageningenBSeriesModel(
        Z=4, EAR=0.6, PD_min=0.8, PD_max=0.8, Re=2_000_000, J_steps=2
    )
    model.sweep()