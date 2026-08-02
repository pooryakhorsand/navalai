# maneuver/williamsom/engine.py
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
def _wrap_to_pi(angle):
    return (angle + np.pi) % (2.0 * np.pi) - np.pi


@njit(cache=True, fastmath=True)
def _simulate_williamson_core(
    x0, h, N, U0, L, m, Iz, xG,
    delta_hard, max_rudder_rate, coef
):
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

    x = x0.copy()

    phase = 1
    ui = delta_hard
    t1 = -1.0
    t2 = -1.0

    psi_hit_60 = np.radians(60.0)
    psi_hit_m130 = np.radians(-130.0)
    psi_opp = np.radians(175.0)

    inv_l = 1.0 / L
    inv_l2 = inv_l * inv_l

    xout = np.empty((N + 1, 11), dtype=np.float64)
    last_idx = 0

    for i in range(N + 1):
        time = i * h

        # ── Rudder rate-limiting ──
        delta_c = -ui
        delta_dot = delta_c - x[6]
        max_step = max_rudder_rate * h
        if delta_dot > max_step:
            delta_dot = max_step
        elif delta_dot < -max_step:
            delta_dot = -max_step

        # ── Speed ──
        U = np.sqrt((U0 + x[0]) ** 2 + x[1] ** 2)
        if U < 1e-12:
            U = 1e-12

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

        # ── Hydrodynamic forces ──
        X_force = (
            Xu * u + Xuu * u2 + Xuuu * u3
            + Xvv * v2 + Xrr * r2 + Xrv * r * v
            + Xdd * d2 + Xudd * u * d2
            + Xvd * v * delta + Xuvd * u * v * delta
        )

        Y_force = (
            Yv * v + Yr * r + Yvvv * v3 + Yvvr * v2 * r
            + Yvu * v * u + Yru * r * u
            + Yd * delta + Yddd * d3
            + Yud * u * delta + Yuud * u2 * delta
            + Yvdd * v * d2 + Yvvd * v2 * delta
            + (Y0 + Y0u * u + Y0uu * u2)
        )

        N_force = (
            Nv * v + Nr * r + Nvvv * v3 + Nvvr * v2 * r
            + Nvu * v * u + Nru * r * u
            + Nd * delta + Nddd * d3
            + Nud * u * delta + Nuud * u2 * delta
            + Nvdd * v * d2 + Nvvd * v2 * delta
            + (N0 + N0u * u + N0uu * u2)
        )

        # ── State derivatives ──
        U2 = U * U
        xdot0 = X_force * (U2 * inv_l) / m11
        xdot1 = -(-m33 * Y_force + m23 * N_force) * (U2 * inv_l) / detM22
        xdot2 = (-m32 * Y_force + m22 * N_force) * (U2 * inv_l2) / detM22

        cpsi = np.cos(psi)
        spsi = np.sin(psi)
        xdot3 = (cpsi * (U0 / U + u) - spsi * v) * U
        xdot4 = (spsi * (U0 / U + u) + cpsi * v) * U
        xdot5 = r * (U * inv_l)
        xdot6 = delta_dot

        # ── Store ──
        xout[i, 0] = time
        xout[i, 1] = x[0]
        xout[i, 2] = x[1]
        xout[i, 3] = x[2]
        xout[i, 4] = x[3]
        xout[i, 5] = x[4]
        xout[i, 6] = x[5]
        xout[i, 7] = x[6]
        xout[i, 8] = U
        xout[i, 9] = float(phase)
        xout[i, 10] = float(ui)

        # ── Euler integration ──
        x[0] += h * xdot0
        x[1] += h * xdot1
        x[2] += h * xdot2
        x[3] += h * xdot3
        x[4] += h * xdot4
        x[5] += h * xdot5
        x[6] += h * xdot6

        last_idx = i

        # ── Phase transitions ──
        psi_now = _wrap_to_pi(x[5])

        if phase == 1 and psi_now >= psi_hit_60:
            ui = -delta_hard
            phase = 2
            t1 = time
        elif phase == 2 and psi_now <= psi_hit_m130:
            ui = 0.0
            phase = 3
            t2 = time
        elif phase == 3 and psi_now >= psi_opp:
            break

    return xout[: last_idx + 1, :], t1, t2


class WilliamsonTurnModel:
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
        h=0.1,
        max_rudder_rate_deg=5.0,
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
        self.max_rudder_rate = float(np.radians(max_rudder_rate_deg))

        local_vars = locals()
        self.coef = np.array(
            [float(local_vars[name]) for name in _COEF_ORDER],
            dtype=np.float64,
        )

    def simulate_williamson(self, Tmax=1200.0):
        N = int(round(float(Tmax) / self.h))
        if N < 1:
            N = 1

        xout, t1, t2 = _simulate_williamson_core(
            self.x_initial,
            self.h,
            N,
            self.U0,
            self.L,
            self.m,
            self.Iz,
            self.xG,
            self.delta1,
            self.max_rudder_rate,
            self.coef,
        )

        t_series = xout[:, 0]
        u_series = xout[:, 1]
        v_series = xout[:, 2]
        r_series = xout[:, 3] * (180.0 / np.pi)
        x_series = xout[:, 4]
        y_series = xout[:, 5]
        psi_series = xout[:, 6] * (180.0 / np.pi)
        delta_actual = xout[:, 7] * (180.0 / np.pi)
        U_series = xout[:, 8]
        rudder_cmd = xout[:, 10] * (180.0 / np.pi)

        # ── Metrics ──
        idx_opp = int(np.argmin(np.abs(psi_series - 180.0)))
        cross_track_error = float(np.abs(y_series[idx_opp]))
        heading_error = float(np.abs(psi_series[idx_opp] - 180.0))
        t_opp = float(t_series[idx_opp])
        max_yaw = float(np.max(np.abs(psi_series)))

        return {
            "t_series": t_series,
            "u_series": u_series,
            "v_series": v_series,
            "r_series": r_series,
            "x_series": x_series,
            "y_series": y_series,
            "psi_series": psi_series,
            "delta_actual_deg": delta_actual,
            "U_series": U_series,
            "rudder_cmd_deg": rudder_cmd,
            "metrics": {
                "cross_track_error_m": cross_track_error,
                "heading_error_deg": heading_error,
                "max_yaw_deg": max_yaw,
            },
            "maneuver_info": {
                "t1_60deg": t1 if t1 >= 0 else None,
                "t2_minus130deg": t2 if t2 >= 0 else None,
                "t_opp_heading": t_opp,
            },
        }


def warmup_numba():
    """
    Optional warm-up function. Call during app startup
    to avoid JIT latency on first real request.
    """
    if not NUMBA_AVAILABLE:
        return

    x0 = np.zeros(7, dtype=np.float64)
    coef = np.zeros(len(_COEF_ORDER), dtype=np.float64)

    _simulate_williamson_core(
        x0,
        0.1,
        1,
        7.0,
        160.0,
        0.00798,
        0.000392,
        -0.023,
        np.radians(35.0),
        np.radians(5.0),
        coef,
    )