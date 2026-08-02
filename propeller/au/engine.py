# propeller/au/engine.py
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


# =============================================================================
# TABLE 6.8 — AU-series geometry dataset
# =============================================================================

SECTION_PROPERTIES = {
    0.20: {'blade_width_pct': 66.54, 'thickness_pct_D': 4.06, 'max_thick_pos_pct': 32.0},
    0.30: {'blade_width_pct': 77.70, 'thickness_pct_D': 3.59, 'max_thick_pos_pct': 32.0},
    0.40: {'blade_width_pct': 87.08, 'thickness_pct_D': 3.12, 'max_thick_pos_pct': 32.0},
    0.50: {'blade_width_pct': 94.34, 'thickness_pct_D': 2.65, 'max_thick_pos_pct': 32.5},
    0.60: {'blade_width_pct': 99.11, 'thickness_pct_D': 2.18, 'max_thick_pos_pct': 34.9},
    0.66: {'blade_width_pct': 100.0, 'thickness_pct_D': 1.90, 'max_thick_pos_pct': 37.9},
    0.70: {'blade_width_pct': 98.64, 'thickness_pct_D': 1.71, 'max_thick_pos_pct': 40.2},
    0.80: {'blade_width_pct': 92.92, 'thickness_pct_D': 1.24, 'max_thick_pos_pct': 45.4},
    0.90: {'blade_width_pct': 73.62, 'thickness_pct_D': 0.77, 'max_thick_pos_pct': 48.9},
    0.95: {'blade_width_pct': 55.62, 'thickness_pct_D': 0.54, 'max_thick_pos_pct': 50.0},
    1.00: {'blade_width_pct': 17.29, 'thickness_pct_D': 0.30, 'max_thick_pos_pct': 50.0},
}

OFFSETS = {
    0.20: [[0,35,24.25],[2,51.85,19.05],[4,59.75,15],[6,66.15,10],[10,76.05,5.4],[15,85.25,2.35],[20,92.2,0],[30,99.8,0],[32,100,0],[40,97.75,0],[50,89.95,0],[60,78.15,0],[70,63.15,0],[80,45.25,0],[90,25.3,0],[95,15,0],[100,4.5,0]],
    0.30: [[0,35,24.25],[2,51.85,19.05],[4,59.75,15],[6,66.15,10],[10,76.05,5.4],[15,85.25,2.35],[20,92.2,0],[30,99.8,0],[32,100,0],[40,97.75,0],[50,89.95,0],[60,78.15,0],[70,63.15,0],[80,45.25,0],[90,25.3,0],[95,15,0],[100,4.5,0]],
    0.40: [[0,35,24.25],[2,51.85,19.05],[4,59.75,15],[6,66.15,10],[10,76.05,5.4],[15,85.25,2.35],[20,92.2,0],[30,99.8,0],[32,100,0],[40,97.75,0],[50,89.95,0],[60,78.15,0],[70,63.15,0],[80,45.25,0],[90,25.3,0],[95,15,0],[100,4.5,0]],
    0.50: [[0,35,24.25],[2.03,51.85,19.05],[4.06,59.75,15],[6.09,66.15,10],[10.16,76.05,5.4],[15.23,85.25,2.35],[20.31,92.2,0],[30.47,99.8,0],[32.5,100,0],[40.44,97.75,0],[50.37,89.95,0],[60.29,78.15,0],[70.22,63.15,0],[80.15,45.25,0],[90.07,25.3,0],[95.04,15,0],[100,4.5,0]],
    0.60: [[0,34,23.6],[2.18,49.6,18.1],[4.36,58,14.25],[6.54,64.75,9.45],[10.91,75.2,5],[16.36,84.8,2.25],[21.81,91.8,0],[32.72,99.8,0],[34.9,100,0],[42.56,97.75,0],[52.13,89.95,0],[61.70,78.15,0],[71.28,63.15,0],[80.85,45.25,0],[90.43,25.3,0],[95.21,15,0],[100,4.5,0]],
    0.70: [[0,30,20.5],[2.51,42.9,15.45],[5.03,52.2,11.95],[7.54,59.9,7.7],[12.56,71.65,4.1],[18.84,82.35,1.75],[25.12,90.6,0],[37.69,99.8,0],[40.2,100,0],[47.23,97.75,0],[56.03,89.95,0],[64.82,78.15,0],[73.62,63.15,0],[82.41,45.25,0],[91.21,25.3,0],[95.6,15,0],[100,4.5,0]],
    0.80: [[0,21,14],[2.84,32.45,10.45],[5.68,41.7,8.05],[8.51,50.1,5.05],[14.19,64.6,2.7],[21.28,78.45,1.15],[28.38,88.9,0],[42.56,99.8,0],[45.4,100,0],[51.82,97.75,0],[59.85,89.95,0],[67.88,78.15,0],[75.91,63.15,0],[83.94,45.25,0],[91.97,25.3,0],[95.99,15,0],[100,4.5,0]],
    0.90: [[0,8.3,4],[3.06,21.1,2.7],[6.11,31.5,2.05],[9.17,40.9,1.2],[15.28,57.45,0.7],[22.92,74.7,0.3],[30.56,87.45,0],[45.85,99.7,0],[48.9,100,0],[54.91,98.65,0],[62.42,92.75,0],[69.94,83,0],[77.46,69.35,0],[84.97,51.85,0],[92.49,30.8,0],[96.24,19.4,0],[100,6.85,0]],
    0.95: [[0,6,0],[3.13,19.65,0],[6.25,30,0],[9.38,39.6,0],[15.63,56.75,0],[23.44,74.3,0],[31.25,87.3,0],[46.87,99.65,0],[50,100,0],[55.88,99,0],[63.23,93.85,0],[70.59,84.65,0],[77.94,71.65,0],[85.30,54.3,0],[92.65,33.5,0],[96.32,21.5,0],[100,8,0]],
}

RADIUS_STATIONS = sorted(OFFSETS.keys())

_KT_RAW = [
    ( 0.00880496,  0, 0, 0, 0), (-0.204554,    1, 0, 0, 0), ( 0.166351,    0, 1, 0, 0),
    ( 0.158114,    0, 2, 0, 0), (-0.147581,    2, 0, 1, 0), (-0.481497,    1, 1, 1, 0),
    ( 0.415437,    0, 2, 1, 0), ( 0.0144043,   0, 0, 0, 1), (-0.0530054,   2, 0, 0, 1),
    ( 0.0143481,   0, 1, 0, 1), ( 0.0606826,   1, 1, 0, 1), (-0.0125894,   0, 0, 1, 1),
    ( 0.0109689,   1, 0, 1, 1), (-0.133698,    0, 3, 0, 0), ( 0.00638407,  0, 6, 0, 0),
    (-0.00132718,  2, 6, 0, 0), ( 0.168496,    3, 0, 1, 0), (-0.0507214,   0, 0, 2, 0),
    ( 0.0854559,   2, 0, 2, 0), (-0.0504475,   3, 0, 2, 0), ( 0.010465,    1, 6, 2, 0),
    (-0.00648272,  2, 6, 2, 0), (-0.00841728,  0, 3, 0, 1), ( 0.0168424,   1, 3, 0, 1),
    (-0.00102296,  3, 3, 0, 1), (-0.0317791,   0, 3, 1, 1), ( 0.018604,    1, 0, 2, 1),
    (-0.00410798,  0, 2, 2, 1), (-0.000606848, 0, 0, 0, 2), (-0.0049819,   1, 0, 0, 2),
    ( 0.0025983,   2, 0, 0, 2), (-0.000560528, 3, 0, 0, 2), (-0.00163652,  1, 2, 0, 2),
    (-0.000328787, 1, 6, 0, 2), ( 0.000116502, 2, 6, 0, 2), ( 0.000690904, 0, 0, 1, 2),
    ( 0.00421749,  0, 3, 1, 2), ( 0.0000565229,3, 6, 1, 2), (-0.00146564,  0, 3, 2, 2),
]

_KQ_RAW = [
    ( 0.00379368,   0, 0, 0, 0), ( 0.00886523,   1, 0, 0, 0), (-0.032241,     2, 0, 0, 0),
    ( 0.00344778,   0, 1, 0, 0), (-0.0408811,    0, 2, 0, 0), (-0.108009,     1, 1, 0, 0),
    (-0.0885381,    2, 1, 0, 0), ( 0.188561,     0, 2, 1, 0), (-0.00370871,   0, 0, 0, 1),
    ( 0.00513696,   1, 0, 0, 1), ( 0.0209449,    0, 1, 0, 1), ( 0.00474319,   1, 1, 0, 1),
    (-0.00723408,   2, 0, 1, 1), ( 0.00438388,   0, 1, 1, 1), (-0.0269403,    0, 2, 1, 1),
    ( 0.0558082,    3, 0, 1, 0), ( 0.0161886,    0, 3, 1, 0), ( 0.00318086,   1, 3, 1, 0),
    ( 0.015896,     0, 0, 2, 0), ( 0.0471729,    1, 0, 2, 0), ( 0.0196283,    3, 1, 2, 0),
    (-0.0502782,    0, 3, 2, 0), (-0.030055,     1, 3, 2, 0), ( 0.0417122,    3, 3, 2, 0),
    (-0.0397722,    0, 6, 2, 0), (-0.00350024,   3, 6, 2, 0), (-0.0106854,    3, 0, 0, 1),
    ( 0.00110903,   3, 3, 0, 2), (-0.000313912,  0, 6, 0, 1), ( 0.0035985,    3, 0, 1, 2),
    (-0.00142121,   0, 6, 1, 2), (-0.00383637,   1, 0, 2, 2), ( 0.0126803,    0, 2, 0, 1),
    (-0.00318278,   2, 3, 0, 1), ( 0.00334268,   0, 6, 0, 2), (-0.00183491,   1, 1, 1, 2),
    ( 0.000112451,  3, 2, 1, 2), (-0.0000297228, 3, 6, 1, 2), ( 0.000269551,  1, 0, 2, 1),
    ( 0.00083265,   2, 0, 2, 1), ( 0.00155334,   0, 2, 2, 1), ( 0.000302683,  0, 6, 2, 1),
    (-0.0001843,    0, 0, 0, 2), (-0.000425399,  0, 3, 0, 2), ( 0.0000869243, 3, 3, 0, 2),
    (-0.0004659,    0, 6, 0, 2), ( 0.0000554194, 1, 6, 0, 2),
]

KT_COEFFS = np.array(_KT_RAW, dtype=np.float64)
KQ_COEFFS = np.array(_KQ_RAW, dtype=np.float64)


@njit(cache=True, fastmath=True)
def _eval_poly(coeffs, J, P_D, AE_AO, Z):
    total = 0.0
    for i in range(coeffs.shape[0]):
        C = coeffs[i, 0]
        s = coeffs[i, 1]
        t = coeffs[i, 2]
        u = coeffs[i, 3]
        v = coeffs[i, 4]
        total += C * (J ** s) * (P_D ** t) * (AE_AO ** u) * (Z ** v)
    return total


@njit(cache=True, fastmath=True)
def _compute_performance_core(kt_coeffs, kq_coeffs, Z, AE_AO, P_D, j_min, j_max, j_step):
    n = int(round((j_max - j_min) / j_step)) + 1

    J_arr = np.empty(n, dtype=np.float64)
    KT_arr = np.empty(n, dtype=np.float64)
    KQ_arr = np.empty(n, dtype=np.float64)
    eta_arr = np.empty(n, dtype=np.float64)

    j_opt = 0.0
    kt_opt = 0.0
    kq_opt = 0.0
    eta_max = 0.0

    twopi = 2.0 * np.pi

    for i in range(n):
        J = j_min + i * j_step

        KT = _eval_poly(kt_coeffs, J, P_D, AE_AO, Z)
        KQ = _eval_poly(kq_coeffs, J, P_D, AE_AO, Z)

        if KQ > 1e-9 and KT > 0.0 and J > 0.0:
            eta = (J * KT) / (twopi * KQ)
        else:
            eta = 0.0

        if KT > 0.0 and eta > eta_max:
            eta_max = eta
            j_opt = J
            kt_opt = KT
            kq_opt = KQ

        J_arr[i] = J
        KT_arr[i] = KT
        KQ_arr[i] = KQ
        eta_arr[i] = eta

    return J_arr, KT_arr, KQ_arr, eta_arr, j_opt, kt_opt, kq_opt, eta_max


class AUSeriesModel:
    """Stateless facade over the numba-accelerated AU-series core."""

    def compute_performance(self, Z, AE_AO, P_D, J_min=0.0, J_max=1.4, J_step=0.01):
        (
            J_arr, KT_arr, KQ_arr, eta_arr,
            j_opt, kt_opt, kq_opt, eta_max
        ) = _compute_performance_core(
            KT_COEFFS, KQ_COEFFS,
            float(Z), float(AE_AO), float(P_D),
            float(J_min), float(J_max), float(J_step)
        )

        return {
            "J_series": J_arr,
            "KT_series": KT_arr,
            "KQ_series": KQ_arr,
            "eta_series": eta_arr,
            "optimum": {
                "J": float(j_opt),
                "KT": float(kt_opt),
                "KQ": float(kq_opt),
                "10KQ": float(kq_opt * 10.0),
                "eta": float(eta_max),
            },
        }

    def compute_section(self, rR, D):
        rR = float(rR)
        D = float(D)

        if rR not in OFFSETS:
            rR = min(OFFSETS.keys(), key=lambda k: abs(k - rR))

        sp = SECTION_PROPERTIES[rR]
        rows = OFFSETS[rR]

        chord_m = (sp["blade_width_pct"] / 100.0) * D
        tmax_m = (sp["thickness_pct_D"] / 100.0) * D
        r_m = rR * (D / 2.0)

        x_m = np.empty(len(rows), dtype=np.float64)
        y_back_m = np.empty(len(rows), dtype=np.float64)
        y_face_m = np.empty(len(rows), dtype=np.float64)
        thickness_m = np.empty(len(rows), dtype=np.float64)

        for i, (X_pct, Y_D_pct, Y_U_pct) in enumerate(rows):
            x = (X_pct / 100.0) * chord_m
            yb = (Y_U_pct / 100.0) * tmax_m
            yf = -(Y_D_pct / 100.0) * tmax_m

            x_m[i] = x
            y_back_m[i] = yb
            y_face_m[i] = yf
            thickness_m[i] = yb - yf

        return {
            "rR": rR,
            "r_m": r_m,
            "chord_m": chord_m,
            "tmax_m": tmax_m,
            "max_thick_pos_pct": sp["max_thick_pos_pct"],
            "x_m": x_m,
            "y_back_m": y_back_m,
            "y_face_m": y_face_m,
            "thickness_m": thickness_m,
        }


def available_radii():
    return list(RADIUS_STATIONS)


def warmup_numba():
    if not NUMBA_AVAILABLE:
        return

    _compute_performance_core(
        KT_COEFFS, KQ_COEFFS,
        5.0, 0.55, 1.0,
        0.0, 1.4, 0.01
    )