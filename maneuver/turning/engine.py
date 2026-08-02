# maneuver/turning/engine.py
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


_COEF_ORDER = [
    "Xudot", "Yvdot", "Nvdot", "Xu", "Yrdot", "Nrdot", "Xuu", "Yv", "Nv",
    "Xuuu", "Yr", "Nr", "Xvv", "Yvvv", "Nvvv", "Xrr", "Yvvr", "Nvvr",
    "Xdd", "Yvu", "Nvu", "Xudd", "Yru", "Nru", "Xrv", "Yd", "Nd", "Xvd",
    "Yddd", "Nddd", "Xuvd", "Yud", "Nud", "Yuud", "Nuud", "Yvdd", "Nvdd",
    "Yvvd", "Nvvd", "Y0", "N0", "Y0u", "N0u", "Y0uu", "N0uu",
]


@njit(cache=True, fastmath=True)
def _simulate_turning_core(x0, h, N, t0, ui, U0, L, m, Iz, xG, coef):
    (
        Xudot, Yvdot, Nvdot, Xu, Yrdot, Nrdot, Xuu, Yv, Nv,
        Xuuu, Yr, Nr, Xvv, Yvvv, Nvvv, Xrr, Yvvr, Nvvr,
        Xdd, Yvu, Nvu, Xudd, Yru, Nru, Xrv, Yd, Nd, Xvd,
        Yddd, Nddd, Xuvd, Yud, Nud, Yuud, Nuud, Yvdd, Nvdd,
        Yvvd, Nvvd, Y0, N0, Y0u, N0u, Y0uu, N0uu
    ) = coef

    m11 = m - Xudot
    m22 = m - Yvdot
    m23 = m * xG - Yrdot
    m32 = m * xG - Nvdot
    m33 = Iz - Nrdot
    detM22 = m22 * m33 - m23 * m32

    xout = np.empty((N + 1, 8), dtype=np.float64)
    x = x0.copy()

    store_tactical = True
    tactical = 0.0

    inv_l = 1.0 / L
    inv_l2 = inv_l * inv_l

    for i in range(N + 1):
        time = i * h

        if store_tactical and round(abs(x[5]) * 180.0 / np.pi) >= 180:
            tactical = x[3]
            store_tactical = False

        rudder = ui if time >= t0 else 0.0

        U = np.sqrt((U0 + x[0]) * (U0 + x[0]) + x[1] * x[1])
        if U < 1e-12:
            U = 1e-12

        delta_c = -rudder

        u = x[0] / U
        v = x[1] / U
        r = x[2] * L / U
        psi = x[5]
        delta = x[6]

        u2 = u * u
        u3 = u2 * u
        v2 = v * v
        v3 = v2 * v
        r2 = r * r
        d2 = delta * delta
        d3 = d2 * delta

        X_force = (
            Xu * u
            + Xuu * u2
            + Xuuu * u3
            + Xvv * v2
            + Xrr * r2
            + Xrv * r * v
            + Xdd * d2
            + Xudd * u * d2
            + Xvd * v * delta
            + Xuvd * u * v * delta
        )

        Y_force = (
            Yv * v
            + Yr * r
            + Yvvv * v3
            + Yvvr * v2 * r
            + Yvu * v * u
            + Yru * r * u
            + Yd * delta
            + Yddd * d3
            + Yud * u * delta
            + Yuud * u2 * delta
            + Yvdd * v * d2
            + Yvvd * v2 * delta
            + (Y0 + Y0u * u + Y0uu * u2)
        )

        N_force = (
            Nv * v
            + Nr * r
            + Nvvv * v3
            + Nvvr * v2 * r
            + Nvu * v * u
            + Nru * r * u
            + Nd * delta
            + Nddd * d3
            + Nud * u * delta
            + Nuud * u2 * delta
            + Nvdd * v * d2
            + Nvvd * v2 * delta
            + (N0 + N0u * u + N0uu * u2)
        )

        U2 = U * U

        xdot0 = X_force * (U2 * inv_l) / m11
        xdot1 = -(-m33 * Y_force + m23 * N_force) * (U2 * inv_l) / detM22
        xdot2 = (-m32 * Y_force + m22 * N_force) * (U2 * inv_l2) / detM22

        cpsi = np.cos(psi)
        spsi = np.sin(psi)

        xdot3 = (cpsi * (U0 / U + u) - spsi * v) * U
        xdot4 = (spsi * (U0 / U + u) + cpsi * v) * U
        xdot5 = r * (U * inv_l)
        xdot6 = delta_c - delta

        xout[i, 0] = time
        xout[i, 1] = x[0]
        xout[i, 2] = x[1]
        xout[i, 3] = x[2]
        xout[i, 4] = x[3]
        xout[i, 5] = x[4]
        xout[i, 6] = x[5]
        xout[i, 7] = U

        x[0] = x[0] + h * xdot0
        x[1] = x[1] + h * xdot1
        x[2] = x[2] + h * xdot2
        x[3] = x[3] + h * xdot3
        x[4] = x[4] + h * xdot4
        x[5] = x[5] + h * xdot5
        x[6] = x[6] + h * xdot6

    return xout, tactical


class TurningModel:
    def __init__(
        self,
        U0,
        L,
        m,
        Iz,
        xG,
        Xudot,
        Yvdot,
        Nvdot,
        Xu,
        Yrdot,
        Nrdot,
        Xuu,
        Yv,
        Nv,
        Xuuu,
        Yr,
        Nr,
        Xvv,
        Yvvv,
        Nvvv,
        Xrr,
        Yvvr,
        Nvvr,
        Xdd,
        Yvu,
        Nvu,
        Xudd,
        Yru,
        Nru,
        Xrv,
        Yd,
        Nd,
        Xvd,
        Yddd,
        Nddd,
        Xuvd,
        Yud,
        Nud,
        Yuud,
        Nuud,
        Yvdd,
        Nvdd,
        Yvvd,
        Nvvd,
        Y0,
        N0,
        Y0u,
        N0u,
        Y0uu,
        N0uu,
        delta1=np.radians(35),
        x0=None,
        h=0.1
    ):
        if x0 is None:
            x0 = np.zeros(7, dtype=np.float64)

        self.x_initial = np.asarray(x0, dtype=np.float64).copy()
        self.U0 = float(U0)
        self.L = float(L)
        self.h = float(h)
        self.m = float(m)
        self.Iz = float(Iz)
        self.xG = float(xG)
        self.delta1 = float(delta1)

        local_vars = locals()
        self.coef = np.array(
            [float(local_vars[name]) for name in _COEF_ORDER],
            dtype=np.float64
        )

    def simulate_turning(self, T=700.0, t0=100.0, ui=None):
        if ui is None:
            ui = -35.0 * np.pi / 180.0

        N = int(round(float(T) / self.h))
        if N < 1:
            N = 1

        xout, tactical = _simulate_turning_core(
            self.x_initial,
            self.h,
            N,
            float(t0),
            float(ui),
            self.U0,
            self.L,
            self.m,
            self.Iz,
            self.xG,
            self.coef
        )

        t_series = xout[:, 0]
        u_series = xout[:, 1]
        v_series = xout[:, 2]
        r_series = xout[:, 3] * (180.0 / np.pi)
        x_series = xout[:, 4]
        y_series = xout[:, 5]
        psi_series = xout[:, 6] * (180.0 / np.pi)
        U_series = xout[:, 7]

        Nrudder = int(round(float(t0) / self.h))
        if Nrudder < 0:
            Nrudder = 0
        elif Nrudder >= x_series.shape[0]:
            Nrudder = x_series.shape[0] - 1

        transfer_val = np.max(np.abs(y_series))
        advance_val = abs(np.max(np.abs(x_series)) - x_series[Nrudder])
        tactical_val = abs(tactical) if tactical != 0.0 else np.nan

        return (
            t_series,
            u_series,
            v_series,
            r_series,
            x_series,
            y_series,
            psi_series,
            U_series,
            transfer_val,
            advance_val,
            tactical_val
        )


def warmup_numba():
    """
    Optional warm-up function. You can call this during app startup
    if you want the first real request to avoid JIT latency.
    """
    if not NUMBA_AVAILABLE:
        return

    x0 = np.zeros(7, dtype=np.float64)
    coef = np.zeros(len(_COEF_ORDER), dtype=np.float64)

    _simulate_turning_core(
        x0,
        0.1,
        1,
        0.0,
        0.0,
        7.0,
        160.0,
        0.00798,
        0.000392,
        -0.023,
        coef
    )